from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
import snap7
from snap7.util import set_bool, set_real, set_int, get_real, get_bool, get_int
from snap7.type import Areas
import time
import uvicorn
import threading
import socket
import json
import logging
import math
import csv
import os
import glob

# =============================================================================
#  CONFIGURACIÓN GLOBAL
# =============================================================================
PLC_IP = "192.168.0.1"
DB_NUMBER = 3
plc_lock = threading.Lock()
app = FastAPI()

app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
plc = snap7.client.Client()

# --- VARIABLES GLOBALES ---
tasmg_data = {"sum_x": 0.0, "sum_y": 0.0, "sum_z": 0.0, "count": 0, "taSMG_val": 1.0, "gx": 0.0, "gy": 0.0, "gz": -1.0}
estado_deseado = {"A": {"rpm": 0.0, "dir": 1}, "B": {"rpm": 0.0, "dir": 1}}
telemetria_cache = {"v90": {}, "s210": {}, "status": "OFFLINE", "master_ip": None}
token_control = {"ip": None, "ultimo_contacto": 0}
TIMEOUT_MASTER = 60 

OFFSETS_V90 = {"start": (0, 0), "enable": (6, 0), "reset_alarm": (6, 1), "speed_rpm": 2, "speed_hacia": 8, "sentido": 12, "rango_aleatorio": 14, "limite_torque": 18}
OFFSETS_S210 = {"start": (22, 0), "enable": (28, 0), "reset_alarm": (28, 1), "speed_rpm": 24, "speed_hacia": 30, "sentido": 34, "rango_aleatorio": 36, "limite_torque": 40}

sensor_cache = {
    "status": "Esperando Driver BLE...", "timestamp": "",
    "vel": {"x":0, "y":0, "z":0}, "angle": {"x":0.0, "y":0.0, "z":0.0},
    "temp": 0.0, "disp": {"x":0, "y":0, "z":0}, "freq": {"x":0, "y":0, "z":0}, "battery": 100
}

csv_logging_active = False
csv_filename = ""
csv_record_count = 0

def get_client_ip(request: Request) -> str:
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded: return forwarded.split(",")[0].strip()
    return request.client.host

def check_master(request: Request) -> bool:
    cliente_ip = get_client_ip(request)
    ahora = time.time()
    if token_control["ip"] is None or (ahora - token_control["ultimo_contacto"] > TIMEOUT_MASTER):
        token_control["ip"] = cliente_ip
        telemetria_cache["master_ip"] = cliente_ip
    if token_control["ip"] == cliente_ip:
        token_control["ultimo_contacto"] = ahora
        return True
    return False

# =============================================================================
#  COMUNICACIÓN BLINDADA (SNAP7)
# =============================================================================
def conectar_seguro():
    with plc_lock: 
        if not plc.get_connected():
            try: plc.disconnect(); plc.connect(PLC_IP, 0, 1)
            except Exception: pass

def write_bit(byte_idx, bit_idx, val):
    with plc_lock:
        if not plc.get_connected(): return
        try:
            data = plc.read_area(Areas.DB, DB_NUMBER, byte_idx, 1)
            set_bool(data, 0, bit_idx, val)
            plc.write_area(Areas.DB, DB_NUMBER, byte_idx, data)
        except Exception: plc.disconnect()

def write_real(byte_idx, val):
    with plc_lock:
        if not plc.get_connected(): return
        try:
            buf = bytearray(4)
            set_real(buf, 0, float(val))
            plc.write_area(Areas.DB, DB_NUMBER, byte_idx, buf)
        except Exception: plc.disconnect()

def write_int(byte_idx, val):
    with plc_lock:
        if not plc.get_connected(): return
        try:
            buf = bytearray(2)
            set_int(buf, 0, int(val))
            plc.write_area(Areas.DB, DB_NUMBER, byte_idx, buf)
        except Exception: plc.disconnect()

def read_bool(byte_idx, bit_idx):
    with plc_lock:
        if not plc.get_connected(): return False
        try:
            data = plc.read_area(Areas.DB, DB_NUMBER, byte_idx, 1)
            return get_bool(data, 0, bit_idx)
        except Exception:
            plc.disconnect(); return False

def read_real(byte_idx):
    with plc_lock:
        if not plc.get_connected(): return 0.0
        try:
            data = plc.read_area(Areas.DB, DB_NUMBER, byte_idx, 4)
            return get_real(data, 0)
        except Exception:
            plc.disconnect(); return 0.0

def read_int(byte_idx):
    with plc_lock:
        if not plc.get_connected(): return 0
        try:
            data = plc.read_area(Areas.DB, DB_NUMBER, byte_idx, 2)
            return get_int(data, 0)
        except Exception:
            plc.disconnect(); return 0

def enviar_datos_directos():
    if not plc.get_connected(): return
    rpm_A = estado_deseado["A"]["rpm"]; dir_A = estado_deseado["A"]["dir"]
    rpm_B = estado_deseado["B"]["rpm"]; dir_B = estado_deseado["B"]["dir"]

    write_real(OFFSETS_V90["speed_rpm"], rpm_A)
    write_int(OFFSETS_V90["sentido"], dir_A)
    write_real(OFFSETS_V90["speed_hacia"], rpm_A if dir_A == 1 else -rpm_A)
    write_real(OFFSETS_S210["speed_rpm"], rpm_B)
    write_int(OFFSETS_S210["sentido"], dir_B)
    write_real(OFFSETS_S210["speed_hacia"], rpm_B if dir_B == 1 else -rpm_B)

def leer_parametros(off):
    return {
        "Arrancar": read_bool(off["start"][0], off["start"][1]),
        "Activar": read_bool(off["enable"][0], off["enable"][1]),
        "Reset_Alarm": read_bool(off["reset_alarm"][0], off["reset_alarm"][1]),
        "Velocidad": read_real(off["speed_rpm"]),
        "Velocidad_Hacia": read_real(off["speed_hacia"]),
        "Sentido": read_int(off["sentido"]),
        "Rango_Aleatorio": read_real(off["rango_aleatorio"]),
        "Limite_Torque": read_real(off["limite_torque"])
    }

def background_plc_poller():
    while True:
        conectar_seguro()
        if plc.get_connected():
            try:
                telemetria_cache["v90"] = leer_parametros(OFFSETS_V90)
                telemetria_cache["s210"] = leer_parametros(OFFSETS_S210)
                telemetria_cache["status"] = "OK"
            except Exception: telemetria_cache["status"] = "ERROR"
        else: telemetria_cache["status"] = "OFFLINE"
        time.sleep(0.2) 

def esp32_udp_listener():
    global tasmg_data
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("0.0.0.0", 8001))
    print("[SISTEMA] Escuchando MPU6050 (ESP32) en UDP 8001...")
    
    while True:
        try:
            data, addr = sock.recvfrom(1024) 
            texto = data.decode('utf-8', errors='ignore').strip()
            if "{" in texto and "}" in texto:
                payload = json.loads(texto[texto.find("{"):texto.rfind("}") + 1])
                pitch_rad = math.radians(float(payload.get("pitch", 0.0)))
                roll_rad  = math.radians(float(payload.get("roll", 0.0)))
                
                tasmg_data["gx"] = math.cos(roll_rad) * math.sin(pitch_rad)
                tasmg_data["gy"] = -math.sin(roll_rad)
                # Agregamos el signo negativo para invertir el vector hacia el suelo
                tasmg_data["gz"] = -(math.cos(roll_rad) * math.cos(pitch_rad))
                
                print(f"[MPU6050-UDP] Pitch: {payload.get('pitch', 0):.2f}° | Roll: {payload.get('roll', 0):.2f}°")
        except Exception: pass

@app.on_event("startup")
async def startup_event():
    threading.Thread(target=background_plc_poller, daemon=True).start()
    threading.Thread(target=esp32_udp_listener, daemon=True).start()

# =============================================================================
#  RUTAS WEB Y API REST (HUD Y SENSORES)
# =============================================================================
@app.get("/")
def serve_index(): return FileResponse("index.html")

@app.get("/telemetry")
def read_telemetry(request: Request):
    cliente_ip = get_client_ip(request)
    respuesta = telemetria_cache.copy()
    if token_control["ip"] == cliente_ip: respuesta["is_master"] = True
    elif token_control["ip"] is None: respuesta["is_master"] = None
    else: respuesta["is_master"] = False
    return respuesta

@app.post("/motor/power/{state}")
def set_power(state: bool, request: Request):
    if not check_master(request): return {"status": "DENIED", "msg": "Modo Observador Activo"}
    conectar_seguro()
    if plc.get_connected():
        write_bit(OFFSETS_V90["enable"][0], OFFSETS_V90["enable"][1], state)
        write_bit(OFFSETS_S210["enable"][0], OFFSETS_S210["enable"][1], state)
    return {"status": "OK" if plc.get_connected() else "OFFLINE"}

@app.post("/motor/start/{state}")
def set_start(state: bool, request: Request):
    if not check_master(request): return {"status": "DENIED"}
    conectar_seguro()
    if plc.get_connected():
        write_bit(OFFSETS_V90["start"][0], OFFSETS_V90["start"][1], state)
        write_bit(OFFSETS_S210["start"][0], OFFSETS_S210["start"][1], state)
    return {"status": "OK" if plc.get_connected() else "OFFLINE"}

@app.post("/control/{motor}/{valor}")
def enviar_velocidad(motor: str, valor: float, request: Request):
    if not check_master(request): return {"status": "DENIED"}
    conectar_seguro()
    m = motor.upper()
    if m in estado_deseado: estado_deseado[m]["rpm"] = valor
    if plc.get_connected(): enviar_datos_directos()
    return {"status": "OK"}

@app.post("/extra/{motor}/{sentido}/{rango}/{torque}")
def enviar_extras(motor: str, sentido: int, rango: float, torque: float, request: Request):
    if not check_master(request): return {"status": "DENIED"}
    conectar_seguro()
    m = motor.upper()
    if m in estado_deseado: estado_deseado[m]["dir"] = sentido
    if plc.get_connected():
        off = OFFSETS_V90 if m == "A" else OFFSETS_S210
        write_real(off["rango_aleatorio"], rango)
        write_real(off["limite_torque"], torque)
        enviar_datos_directos()
    return {"status": "OK"}

@app.post("/emergency")
def stop_total(request: Request):
    conectar_seguro()
    estado_deseado["A"]["rpm"] = 0.0; estado_deseado["A"]["dir"] = 1
    estado_deseado["B"]["rpm"] = 0.0; estado_deseado["B"]["dir"] = 1
    if plc.get_connected():
        for off in [OFFSETS_V90, OFFSETS_S210]:
            write_bit(off["start"][0], off["start"][1], False)
            write_bit(off["enable"][0], off["enable"][1], False)
            write_real(off["speed_rpm"], 0.0)
            write_real(off["speed_hacia"], 0.0)
            write_real(off["rango_aleatorio"], 0.0)
            write_real(off["limite_torque"], 0.0)
            write_int(off["sentido"], 1)
            write_bit(off["reset_alarm"][0], off["reset_alarm"][1], True)
        time.sleep(0.5)
        for off in [OFFSETS_V90, OFFSETS_S210]: write_bit(off["reset_alarm"][0], off["reset_alarm"][1], False)
    
    token_control["ip"] = request.client.host
    token_control["ultimo_contacto"] = time.time()
    telemetria_cache["master_ip"] = request.client.host
    return {"msg": "HALT_AND_RESET_COMPLETE"}

@app.post("/internal/wtvb01")
async def update_wtvb01(request: Request):
    global sensor_cache, csv_record_count
    data = await request.json()
    sensor_cache.update(data)
    
    if csv_logging_active and csv_filename and data["status"] == "Conectado":
        vRms = round(math.sqrt(data["vel"]["x"]**2 + data["vel"]["y"]**2 + data["vel"]["z"]**2), 1)
        dRms = round(math.sqrt(data["disp"]["x"]**2 + data["disp"]["y"]**2 + data["disp"]["z"]**2), 0)
        row = [
            data["timestamp"], data["vel"]["x"], data["vel"]["y"], data["vel"]["z"], vRms,
            data["angle"]["x"], data["angle"]["y"], data["angle"]["z"], data["temp"],
            data["disp"]["x"], data["disp"]["y"], data["disp"]["z"], dRms,
            data["freq"]["x"], data["freq"]["y"], data["freq"]["z"], data["battery"]
        ]
        with open(csv_filename, mode='a', newline='') as f:
            csv.writer(f).writerow(row)
        csv_record_count += 1
        
    return {"status": "ok"}

@app.get("/sensor_data")
def read_sensor(request: Request):
    respuesta = sensor_cache.copy()
    respuesta["angle"] = dict(sensor_cache["angle"])
    
    if respuesta["status"] == "Conectado":
        pitch_rad = math.radians(respuesta["angle"]["x"])
        roll_rad  = math.radians(respuesta["angle"]["y"])
        gx = math.cos(roll_rad) * math.sin(pitch_rad)
        gy = -math.sin(roll_rad)
        # Agregamos el signo negativo aquí también
        gz = -(math.cos(roll_rad) * math.cos(pitch_rad))
        respuesta["tasmg"] = {"gx": gx, "gy": gy, "gz": gz, "taSMG_val": math.sqrt(gx**2 + gy**2 + gz**2)}
    else:
        gy_seguro = max(-1.0, min(1.0, -tasmg_data.get("gy", 0.0)))
        gx_seguro = max(-1.0, min(1.0, tasmg_data.get("gx", 0.0)))
        respuesta["angle"]["x"] = round(math.degrees(math.asin(gx_seguro)), 2)
        respuesta["angle"]["y"] = round(math.degrees(math.asin(gy_seguro)), 2)
        respuesta["tasmg"] = tasmg_data 
        
    respuesta["is_logging"] = csv_logging_active
    respuesta["csv_count"] = csv_record_count
    return respuesta

@app.post("/sensor_log/{state}")
def toggle_sensor_log(state: bool, request: Request):
    global csv_logging_active, csv_filename, csv_record_count
    csv_logging_active = state
    if state:
        csv_record_count = 0 
        csv_filename = f"telemetria_wtvb01_{int(time.time())}.csv"
        with open(csv_filename, mode='w', newline='') as f:
            f.write("Timestamp,VelX,VelY,VelZ,VelRMS,AngleX,AngleY,AngleZ,Temp,DispX,DispY,DispZ,DispRMS,FreqX,FreqY,FreqZ,Battery\n")
        return {"status": "OK", "msg": f"Grabando en PC: {csv_filename}"}
    return {"status": "OK", "msg": "Grabación detenida"}

@app.get("/descargar_csv")
def descargar_ultimo_csv():
    archivos_csv = glob.glob("telemetria_wtvb01_*.csv")
    if not archivos_csv: return {"status": "ERROR", "msg": "No hay archivos generados aún."}
    ultimo_archivo = max(archivos_csv, key=os.path.getctime)
    return FileResponse(ultimo_archivo, media_type="text/csv", filename=ultimo_archivo)

app.mount("/img", StaticFiles(directory="img"), name="img")
app.mount("/WTVB01-BT50 - dashboard", StaticFiles(directory="WTVB01-BT50 - dashboard", html=True), name="dashboard")
app.mount("/", StaticFiles(directory=".", html=True), name="static")

if __name__ == "__main__":
    print("[SISTEMA] Motor FastAPI SCADA iniciado.")
    logging.getLogger("uvicorn.access").disabled = True
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="warning")