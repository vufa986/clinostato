import os
import sys
import time
import requests
import threading
from rich.console import Console
from rich.layout import Layout
from rich.panel import Panel
from rich.table import Table
from rich.live import Live
from rich.text import Text

NGROK_API_URL = "http://127.0.0.1:4040/api/tunnels"
NGROK_REQ_URL = "http://127.0.0.1:4040/api/requests/http?limit=3"
SCADA_API_URL = "http://127.0.0.1:8000"
LOG_FILE = "debug.log"

console = Console()
log_file_pos = 0
log_buffer = []
MAX_LOG_LINES = 12

# Variables del Watchdog (God Mode)
START_TIME = time.time()
MAX_LATENCY = 0.0

# Sesión blindada: Ignora proxies de Windows
session = requests.Session()
session.trust_env = False 

def obtener_estado_ngrok():
    info = {"status": "OFFLINE", "url": "N/A", "error": "Ngrok cerrado", "requests": []}
    try:
        res = session.get(NGROK_API_URL, timeout=0.5)
        if res.status_code == 200:
            tunnels = res.json().get("tunnels", [])
            if tunnels:
                info["status"] = "ONLINE"
                info["url"] = tunnels[0].get("public_url", "N/A")
                info["error"] = None
                
                try:
                    reqs = session.get(NGROK_REQ_URL, timeout=0.5)
                    if reqs.status_code == 200:
                        historial = reqs.json().get("requests", [])
                        for r in historial:
                            method = r.get("request", {}).get("method", "GET")
                            uri = r.get("request", {}).get("uri", "/")
                            status = r.get("response", {}).get("status_code", "---")
                            uri_short = (uri[:15] + '..') if len(uri) > 15 else uri
                            info["requests"].append(f"{method} {uri_short} [{status}]")
                except Exception:
                    pass
    except requests.exceptions.ConnectionError:
        info["error"] = "Proceso inactivo o puerto 4040 cerrado"
    except Exception as e:
        # Si ocurre otro error, lo cortamos a 35 caracteres para que no deforme la interfaz
        info["error"] = str(e)[:35] + "..."
    return info

def obtener_telemetria_servidor():
    global MAX_LATENCY
    datos = {"sensor": None, "plc": None, "api_error": None, "latency_ms": 0}
    t_start = time.perf_counter()
    
    try:
        res_plc = session.get(f"{SCADA_API_URL}/telemetry?_t={time.time()}", timeout=1.5)
        if res_plc.status_code == 200: 
            datos["plc"] = res_plc.json()
        else:
            datos["api_error"] = f"Error HTTP {res_plc.status_code}"
    except Exception as e: 
        datos["api_error"] = str(e)[:60] + "..." if len(str(e)) > 60 else str(e)
        
    try:
        res_sensor = session.get(f"{SCADA_API_URL}/sensor_data?_t={time.time()}", timeout=1.5)
        if res_sensor.status_code == 200: 
            datos["sensor"] = res_sensor.json()
    except Exception: pass
    
    # Calcular y registrar el pico máximo de latencia
    current_latency = (time.perf_counter() - t_start) * 1000
    datos["latency_ms"] = current_latency
    if current_latency > MAX_LATENCY and current_latency < 5000: # Ignoramos timeouts puros
        MAX_LATENCY = current_latency
        
    return datos

def tail_logs():
    global log_file_pos, log_buffer
    if not os.path.exists(LOG_FILE):
        return ["Esperando a que el sistema genere el archivo de eventos (debug.log)..."]
    
    basura_windows = ["Disconnected from", "_ProactorBasePipeTransport", "asyncio\\events.py", "asyncio\\proactor_events.py", "WinError 10054", "handle: <Handle", "self._context.run(", "Traceback (most recent call last):", "self._sock.shutdown(socket.SHUT_RDWR)", "~~~~~~~~~"]

    try:
        with open(LOG_FILE, "r", encoding="utf-8") as f:
            f.seek(log_file_pos)
            nuevas_lineas = f.readlines()
            log_file_pos = f.tell()
            if nuevas_lineas:
                for linea in nuevas_lineas:
                    clean_line = linea.strip()
                    if any(basura in clean_line for basura in basura_windows) or not clean_line:
                        continue 
                    
                    if "[ERROR]" in clean_line or "CRITICAL" in clean_line: clean_line = f"[bold red]{clean_line}[/bold red]"
                    elif "[WARNING]" in clean_line: clean_line = f"[yellow]{clean_line}[/yellow]"
                    elif "[INFO]" in clean_line: clean_line = f"[cyan]{clean_line}[/cyan]"
                    elif "[SENSOR-BLE]" in clean_line: clean_line = f"[magenta]{clean_line}[/magenta]"
                    elif "[SENSOR-UDP]" in clean_line: clean_line = f"[green]{clean_line}[/green]"
                    
                    log_buffer.append(clean_line)
                    
                if len(log_buffer) > MAX_LOG_LINES: log_buffer[:] = log_buffer[-MAX_LOG_LINES:]
    except Exception: pass
    return log_buffer

def generar_interfaz(layout, ngrok_info, telemetria):
    reloj_actual = time.strftime("%H:%M:%S")
    
    # 1. PANEL SUPERIOR: Infraestructura y Ngrok
    table_infra = Table.grid(expand=True)
    table_infra.add_column(ratio=1); table_infra.add_column(ratio=1)
    
    ngrok_display = ngrok_info["status"] if ngrok_info["status"] == "ONLINE" else f"OFFLINE ({ngrok_info['error']})"
    trafico_ngrok = " | ".join(ngrok_info["requests"]) if ngrok_info.get("requests") else "Esperando tráfico HTTP..."
    
    txt_ngrok = Text.assemble(
        ("TUNEL NGROK: ", "bold white"), 
        (ngrok_display, "bold green" if ngrok_info["status"] == "ONLINE" else "bold red"), 
        (f" -> {ngrok_info['url']}\n", "cyan"),
        ("TRÁFICO VIVO (Últ. 3): ", "bold yellow"),
        (trafico_ngrok, "magenta")
    )
    
    master_ip = "NADIE"
    if telemetria["api_error"]:
        plc_status = f"API INACCESIBLE ({telemetria['api_error']})"
        plc_color = "red"
    else:
        plc_status = telemetria["plc"].get("status", "OFFLINE") if telemetria["plc"] else "OFFLINE"
        plc_color = "green" if plc_status == "OK" else ("yellow" if plc_status == "ERROR" else "red")
        if telemetria["plc"] and telemetria["plc"].get("master_ip"):
            master_ip = telemetria["plc"].get("master_ip")
            
    lat_ms = telemetria['latency_ms']
    lat_color = "bold green" if lat_ms < 100 else ("bold yellow" if lat_ms < 300 else "bold red")
            
    txt_plc = Text.assemble(
        ("API SCADA: ", "bold white"), 
        (plc_status, f"bold {plc_color}"), 
        (" | MANDO: ", "bold white"),
        (master_ip, "bold yellow" if master_ip != "NADIE" else "gray"),
        (" | LATENCIA: ", "bold white"),
        (f"{lat_ms:.0f} ms", lat_color)
    )
    
    table_infra.add_row(txt_ngrok, txt_plc)
    layout["upper"].update(Panel(table_infra, title=f"📡 INFRAESTRUCTURA DE RED [Reloj Local: {reloj_actual}]", border_style="blue"))

    # 2. PANEL MEDIO-SUPERIOR: ESTADO DE LOS SERVOMOTORES
    if telemetria["plc"] and "v90" in telemetria["plc"]:
        v90 = telemetria["plc"]["v90"]; s210 = telemetria["plc"]["s210"]
        target = telemetria["plc"].get("target", {"A": {"rpm": 0.0, "dir": 1}, "B": {"rpm": 0.0, "dir": 1}})
        
        table_motores = Table(show_header=True, header_style="bold blue", expand=True)
        table_motores.add_column("Parámetro SCADA", style="white")
        table_motores.add_column("AXIS X (Siemens V90)", justify="center", style="bold cyan")
        table_motores.add_column("AXIS Y (Siemens S210)", justify="center", style="bold magenta")
        
        pwr_v90 = "[bold green]ON[/]" if v90.get("Activar") else "[bold red]OFF[/]"
        pwr_s210 = "[bold green]ON[/]" if s210.get("Activar") else "[bold red]OFF[/]"
        run_v90 = "[bold green]RUNNING[/]" if v90.get("Arrancar") else "[bold yellow]STOP[/]"
        run_s210 = "[bold green]RUNNING[/]" if s210.get("Arrancar") else "[bold yellow]STOP[/]"
        dir_v90 = "Horario" if v90.get("Sentido") == 1 else "Antihorario"
        dir_s210 = "Horario" if s210.get("Sentido") == 1 else "Antihorario"
        tgt_dir_v90 = "Horario" if target["A"]["dir"] == 1 else "Antihorario"
        tgt_dir_s210 = "Horario" if target["B"]["dir"] == 1 else "Antihorario"
        
        # MODO DIOS: Cálculo de la Desviación Mecánica (Tracking Error)
        slip_v90 = target["A"]["rpm"] - v90.get("Velocidad", 0.0)
        slip_s210 = target["B"]["rpm"] - s210.get("Velocidad", 0.0)
        c_slip_v90 = "bold red" if abs(slip_v90) > 0.5 else "bold green"
        c_slip_s210 = "bold red" if abs(slip_s210) > 0.5 else "bold green"
        
        table_motores.add_row("Poder Eléctrico (Activar)", pwr_v90, pwr_s210)
        table_motores.add_row("Marcha Activa (Arrancar)", run_v90, run_s210)
        table_motores.add_row("🎯 TARGET: Velocidad (Web)", f"[yellow]{target['A']['rpm']:.3f} RPM[/yellow]", f"[yellow]{target['B']['rpm']:.3f} RPM[/yellow]")
        table_motores.add_row("⚙️ ACTUAL: Vel. Física (PLC)", f"[green]{v90.get('Velocidad', 0.0):.3f} RPM[/green]", f"[green]{s210.get('Velocidad', 0.0):.3f} RPM[/green]")
        table_motores.add_row("⚖️ ERROR: Desvío Mecánico", f"[{c_slip_v90}]±{abs(slip_v90):.3f} RPM[/{c_slip_v90}]", f"[{c_slip_s210}]±{abs(slip_s210):.3f} RPM[/{c_slip_s210}]")
        table_motores.add_row("🎯 TARGET: Dirección (Web)", f"[yellow]{tgt_dir_v90}[/yellow]", f"[yellow]{tgt_dir_s210}[/yellow]")
        table_motores.add_row("⚙️ ACTUAL: Dirección (PLC)", f"[green]{dir_v90}[/green]", f"[green]{dir_s210}[/green]")
        
        layout["mid_top"].update(Panel(table_motores, title="⚙️ ESTADO DE SERVOMOTORES Y RENDIMIENTO CINEMÁTICO", border_style="cyan"))
    else:
        layout["mid_top"].update(Panel(Text("\nEsperando telemetría del PLC o resolviendo bloqueo de API...", justify="center", style="yellow"), title="⚙️ ESTADO DE SERVOMOTORES", border_style="red"))

    # 3. PANEL MEDIO-INFERIOR: SENSORES BIOMÉTRICOS Y DATALOGGER
    if telemetria["sensor"] and "tasmg" in telemetria["sensor"]:
        is_logging = telemetria["sensor"].get("is_logging", False)
        csv_count = telemetria["sensor"].get("csv_count", 0)
        log_status = "[bold green]GRABANDO[/]" if is_logging else "[bold gray]EN PAUSA[/]"
        
        mpu = telemetria["sensor"]["tasmg"]
        table_mpu = Table(show_header=True, header_style="bold yellow", expand=True)
        table_mpu.add_column("Vector de Gravedad", style="white"); table_mpu.add_column("Valor Crudo", justify="right", style="bold cyan")
        
        table_mpu.add_row("Eje X (gx) / Eje Y (gy)", f"{mpu.get('gx', 0.0):.4f} / {mpu.get('gy', 0.0):.4f}")
        table_mpu.add_row("Eje Z (gz)", f"{mpu.get('gz', 0.0):.4f}")
        table_mpu.add_row("Magnitud Estabilizada", f"{mpu.get('taSMG_val', 1.0):.5f} G")
        table_mpu.add_row("Registro Histórico (CSV)", f"{log_status} ({csv_count} líneas)")
        
        status_udp = "ESCUCHANDO" if mpu.get("count", 0) > 0 else "SIN TRÁFICO"
        layout["mid_bottom_left"].update(Panel(table_mpu, title=f"🪐 MPU6050 [UDP 8001 - {status_udp}]", border_style="green" if status_udp == "ESCUCHANDO" else "red"))
    else: layout["mid_bottom_left"].update(Panel(Text("\nSin señal UDP...", justify="center", style="yellow"), title="🪐 MPU6050", border_style="red"))

    if telemetria["sensor"]:
        s = telemetria["sensor"]; status_ble = s.get("status", "Desconectado")
        table_ble = Table(show_header=True, header_style="bold magenta", expand=True)
        table_ble.add_column("Métrica BLE", style="white"); table_ble.add_column("Lectura", justify="right", style="bold cyan")
        
        ult_ping = s.get("timestamp", "--:--:--")
        batt = s.get("battery", 100)
        temp = s.get("temp", 0.0)
        
        table_ble.add_row("Último Ping (Conexión)", f"[yellow]{ult_ping}[/yellow]")
        table_ble.add_row("Batería / Temp. Interna", f"{batt}% / {temp}°C")
        table_ble.add_row("Ángulo X / Y / Z", f"{s['angle']['x']}° / {s['angle']['y']}° / {s['angle']['z']}°")
        table_ble.add_row("Velocidad RMS Total", f"{s['vel']['x']} mm/s")
        
        layout["mid_bottom_right"].update(Panel(table_ble, title=f"📡 WITMOTION [{status_ble.upper()}]", border_style="green" if status_ble == "Conectado" else "red"))
    else: layout["mid_bottom_right"].update(Panel(Text("\nSin señal BLE...", justify="center", style="yellow"), title="📡 WITMOTION", border_style="red"))

    # 4. NUEVO WIDGET MODO DIOS: DIAGNÓSTICO DEL SERVIDOR HOST
    uptime_secs = int(time.time() - START_TIME)
    uptime_str = f"{uptime_secs // 3600:02d}:{(uptime_secs % 3600) // 60:02d}:{uptime_secs % 60:02d}"
    hilos = threading.active_count()
    
    table_health = Table.grid(expand=True)
    table_health.add_column(ratio=1); table_health.add_column(ratio=1); table_health.add_column(ratio=1)
    
    txt_up = Text.assemble(("⏱️ Uptime Depurador: ", "white"), (uptime_str, "bold cyan"))
    txt_th = Text.assemble(("🧵 Hilos Locales (Host): ", "white"), (str(hilos), "bold magenta"))
    txt_lat = Text.assemble(("⚠️ Pico Máx. Latencia: ", "white"), (f"{MAX_LATENCY:.0f} ms", "bold red" if MAX_LATENCY > 300 else "bold yellow"))
    
    table_health.add_row(txt_up, txt_th, txt_lat)
    layout["sys_health"].update(Panel(table_health, title="🔬 DIAGNÓSTICO DE RENDIMIENTO DEL HOST (WATCHDOG)", border_style="yellow"))

    # 5. PANEL INFERIOR: LOGS
    logs_actuales = tail_logs()
    texto_logs = "\n".join(logs_actuales) if logs_actuales else "Logs limpios. Esperando eventos..."
    layout["lower"].update(Panel(texto_logs, title="🖥️ FLUJO DE DATOS DEL NÚCLEO (debug.log)", border_style="white", padding=(0, 2)))

def main():
    layout = Layout()
    layout.split_column(
        Layout(name="upper", size=4),
        Layout(name="mid_top", size=10),     # Aumentado para mostrar la desviación de Tracking
        Layout(name="mid_bottom", size=8),   
        Layout(name="sys_health", size=3),   # NUEVO WIDGET HOST
        Layout(name="lower", ratio=1)        
    )
    layout["mid_bottom"].split_row(
        Layout(name="mid_bottom_left", ratio=1),
        Layout(name="mid_bottom_right", ratio=1)
    )

    console.clear()
    console.print("[bold green]Iniciando Consola de Ingeniería Extrema (God Mode)...[/bold green]")
    time.sleep(1)

    with Live(layout, refresh_per_second=4, screen=True) as live:
        while True:
            generar_interfaz(layout, obtener_estado_ngrok(), obtener_telemetria_servidor())
            time.sleep(0.25)

if __name__ == "__main__":
    try: main()
    except KeyboardInterrupt: console.print("\n[bold yellow]Panel cerrado.[/bold yellow]")