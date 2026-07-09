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
import asyncio
import csv
import os
import math
import glob
from bleak import BleakClient, BleakScanner
from contextlib import asynccontextmanager
import socket
import json
import sys
import logging

# =============================================================================
#  CONFIGURACIÓN GLOBAL
# =============================================================================
PLC_IP = "192.168.0.1"
DB_NUMBER = 3

# UUIDs del WitMotion
WITMOTION_SERVICE_UUID = "0000ffe5-0000-1000-8000-00805f9a34fb"
WITMOTION_CHAR_UUID    = "0000ffe4-0000-1000-8000-00805f9a34fb"

plc_lock = threading.Lock()
LOCK_TIMEOUT = 0.3  # Máximo tiempo que esperará la web (Evita que se congele)

# Configuración de Logging Profesional
LOG_FORMAT = "%(asctime)s [%(levelname)s] %(message)s"

# Crear logger personalizado
logger = logging.getLogger("NexusSCADA")

# Nivel de entorno: cambia a logging.DEBUG en desarrollo, logging.WARNING en producción
DEBUG_MODE = False

if DEBUG_MODE:
    # En desarrollo, ver todo detallado por pantalla
    logging.basicConfig(level=logging.DEBUG, format=LOG_FORMAT)
else:
    # En producción, guardar la depuración pesada en un archivo oculto y limpiar la consola
    logging.basicConfig(
        level=logging.INFO,
        format=LOG_FORMAT,
        handlers=[
            logging.FileHandler("debug.log", encoding="utf-8"),
            logging.StreamHandler(sys.stdout) # Solo mensajes importantes por consola
        ]
    )

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

plc = snap7.client.Client()

# --- VARIABLES GLOBALES ---
tasmg_data = {
    "sum_x": 0.0, "sum_y": 0.0, "sum_z": 0.0,
    "count": 0,
    "taSMG_val": 1.0, 
    "gx": 0.0, "gy": 0.0, "gz": -1.0 
}

estado_deseado = {
    "A": {"rpm": 0.0, "dir": 1},
    "B": {"rpm": 0.0, "dir": 1}
}

telemetria_cache = {
    "v90": {},
    "s210": {},
    "status": "OFFLINE",
    "master_ip": None
}

token_control = {
    "ip": None,
    "ultimo_contacto": 0
}
TIMEOUT_MASTER = 60 

OFFSETS_V90 = {
    "start": (0, 0), "enable": (6, 0), "reset_alarm": (6, 1),
    "speed_rpm": 2, "speed_hacia": 8, "sentido": 12,
    "rango_aleatorio": 14, "limite_torque": 18
}

OFFSETS_S210 = {
    "start": (22, 0), "enable": (28, 0), "reset_alarm": (28, 1),
    "speed_rpm": 24, "speed_hacia": 30, "sentido": 34,
    "rango_aleatorio": 36, "limite_torque": 40
}

sensor_cache = {
    "status": "Buscando Sensor...",
    "timestamp": "",
    "vel": {"x":0, "y":0, "z":0},
    "angle": {"x":0.0, "y":0.0, "z":0.0},
    "temp": 0.0,
    "disp": {"x":0, "y":0, "z":0},
    "freq": {"x":0, "y":0, "z":0},
    "battery": 100
}

csv_logging_active = False
csv_filename = ""
csv_record_count = 0
ble_buffer = bytearray()

# =============================================================================
#  SISTEMA DE SEGURIDAD Y PRIVILEGIOS
# =============================================================================
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
#  COMUNICACIÓN BLINDADA (SNAP7) CON PREVENCIÓN DE CONGELAMIENTO
# =============================================================================
def conectar_seguro():
    if not plc.get_connected():
        # Damos 1 segundo máximo para intentar reconectar en background
        if plc_lock.acquire(timeout=1.0): 
            try:
                if not plc.get_connected():
                    plc.disconnect() 
                    plc.connect(PLC_IP, 0, 1)
            except Exception: pass
            finally:
                plc_lock.release()

def write_bit(byte_idx, bit_idx, val):
    if plc_lock.acquire(timeout=LOCK_TIMEOUT):
        try:
            if plc.get_connected():
                data = plc.read_area(Areas.DB, DB_NUMBER, byte_idx, 1)
                set_bool(data, 0, bit_idx, val)
                plc.write_area(Areas.DB, DB_NUMBER, byte_idx, data)
        except Exception: 
            plc.disconnect()
        finally:
            plc_lock.release()

def write_real(byte_idx, val):
    if plc_lock.acquire(timeout=LOCK_TIMEOUT):
        try:
            if plc.get_connected():
                buf = bytearray(4)
                set_real(buf, 0, float(val))
                plc.write_area(Areas.DB, DB_NUMBER, byte_idx, buf)
        except Exception: 
            plc.disconnect()
        finally:
            plc_lock.release()

def write_int(byte_idx, val):
    if plc_lock.acquire(timeout=LOCK_TIMEOUT):
        try:
            if plc.get_connected():
                buf = bytearray(2)
                set_int(buf, 0, int(val))
                plc.write_area(Areas.DB, DB_NUMBER, byte_idx, buf)
        except Exception: 
            plc.disconnect()
        finally:
            plc_lock.release()

def read_bool(byte_idx, bit_idx):
    if plc_lock.acquire(timeout=LOCK_TIMEOUT):
        try:
            if plc.get_connected():
                data = plc.read_area(Areas.DB, DB_NUMBER, byte_idx, 1)
                return get_bool(data, 0, bit_idx)
        except Exception:
            plc.disconnect()
        finally:
            plc_lock.release()
    return False

def read_real(byte_idx):
    if plc_lock.acquire(timeout=LOCK_TIMEOUT):
        try:
            if plc.get_connected():
                data = plc.read_area(Areas.DB, DB_NUMBER, byte_idx, 4)
                return get_real(data, 0)
        except Exception:
            plc.disconnect()
        finally:
            plc_lock.release()
    return 0.0

def read_int(byte_idx):
    if plc_lock.acquire(timeout=LOCK_TIMEOUT):
        try:
            if plc.get_connected():
                data = plc.read_area(Areas.DB, DB_NUMBER, byte_idx, 2)
                return get_int(data, 0)
        except Exception:
            plc.disconnect()
        finally:
            plc_lock.release()
    return 0

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

def forzar_reseteo_plc():
    print("[SISTEMA] Ejecutando Handshake de limpieza de memorias PLC...")
    conectar_seguro()
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
        for off in [OFFSETS_V90, OFFSETS_S210]: 
            write_bit(off["reset_alarm"][0], off["reset_alarm"][1], False)
        print("[SISTEMA] PLC reseteado exitosamente. Listo para operar.")
    else:
        print("[SISTEMA] No se detectó PLC en el arranque.")

# Reemplaza estas funciones en tu backend principal

def background_plc_poller():
    """Poller optimizado que lee todo el DB3 en un solo viaje de red (Bulk Read)"""
    time.sleep(2) 
    while True:
        conectar_seguro()
        if plc.get_connected():
            try:
                # 1. Una sola petición de red para bajar los 44 bytes del DB3
                with plc_lock:
                    buffer_db = plc.read_area(Areas.DB, DB_NUMBER, 0, 44)
                
                # 2. Decodificación local instantánea en memoria RAM (Sin latencia de red)
                telemetria_cache["v90"] = {
                    "Arrancar": get_bool(buffer_db, 0, 0),
                    "Activar": get_bool(buffer_db, 6, 0),
                    "Reset_Alarm": get_bool(buffer_db, 6, 1),
                    "Velocidad": get_real(buffer_db, 2),
                    "Velocidad_Hacia": get_real(buffer_db, 8),
                    "Sentido": get_int(buffer_db, 12),
                    "Rango_Aleatorio": get_real(buffer_db, 14),
                    "Limite_Torque": get_real(buffer_db, 18)
                }
                
                telemetria_cache["s210"] = {
                    "Arrancar": get_bool(buffer_db, 22, 0),
                    "Activar": get_bool(buffer_db, 28, 0),
                    "Reset_Alarm": get_bool(buffer_db, 28, 1),
                    "Velocidad": get_real(buffer_db, 24),
                    "Velocidad_Hacia": get_real(buffer_db, 30),
                    "Sentido": get_int(buffer_db, 34),
                    "Rango_Aleatorio": get_real(buffer_db, 36),
                    "Limite_Torque": get_real(buffer_db, 40)
                }
                telemetria_cache["status"] = "OK"
            except Exception:
                telemetria_cache["status"] = "ERROR"
        else:
            telemetria_cache["status"] = "OFFLINE"
        time.sleep(0.15) # Puedes bajar el intervalo de forma segura gracias a la optimización

# =============================================================================
#  OÍDO UDP PARA EL ESP32 (taSMG)
# =============================================================================
def esp32_udp_listener():
    global tasmg_data, csv_logging_active
    UDP_IP = "0.0.0.0"
    UDP_PORT = 8001
    
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind((UDP_IP, UDP_PORT))
    print(f"[SISTEMA] Escuchando telemetría interna (ESP32) en puerto UDP {UDP_PORT}...")
    
    while True:
        try:
            data, addr = sock.recvfrom(1024) 
            texto_recibido = data.decode('utf-8', errors='ignore').strip()
            
            if not texto_recibido: continue
                
            if "{" in texto_recibido and "}" in texto_recibido:
                inicio = texto_recibido.find("{")
                fin = texto_recibido.rfind("}") + 1
                json_limpio = texto_recibido[inicio:fin]
                
                payload = json.loads(json_limpio)
                
                pitch_rad = math.radians(float(payload.get("pitch", 0.0)))
                roll_rad  = math.radians(float(payload.get("roll", 0.0)))
                
                gx = math.cos(roll_rad) * math.sin(pitch_rad)
                gy = -math.sin(roll_rad)
                gz = math.cos(roll_rad) * math.cos(pitch_rad)
                
                tasmg_data["gx"] = gx
                tasmg_data["gy"] = gy
                tasmg_data["gz"] = gz
                
                if csv_logging_active:
                    tasmg_data["sum_x"] += gx
                    tasmg_data["sum_y"] += gy
                    tasmg_data["sum_z"] += gz
                    tasmg_data["count"] += 1
                    
                    avg_x = tasmg_data["sum_x"] / tasmg_data["count"]
                    avg_y = tasmg_data["sum_y"] / tasmg_data["count"]
                    avg_z = tasmg_data["sum_z"] / tasmg_data["count"]
                    
                    tasmg_data["taSMG_val"] = math.sqrt(avg_x**2 + avg_y**2 + avg_z**2)
                    
                time.sleep(0.001)
            else:
                pass
                
        except json.JSONDecodeError: pass
        except Exception: pass

# =============================================================================
#  DECODIFICADOR BLUETOOTH (WITMOTION)
# =============================================================================
def combine_signed(low, high):
    val = (high << 8) | low
    return val - 65536 if val >= 32768 else val

def witmotion_rx_handler(sender, data: bytearray):
    global ble_buffer, sensor_cache, csv_logging_active, csv_filename, csv_record_count
    ble_buffer.extend(data)
    
    while len(ble_buffer) >= 28:
        if ble_buffer[0] == 0x55 and ble_buffer[1] == 0x61:
            p = ble_buffer[:28]
            
            sensor_cache["vel"]["x"] = (p[3]<<8)|p[2]
            sensor_cache["vel"]["y"] = (p[5]<<8)|p[4]
            sensor_cache["vel"]["z"] = (p[7]<<8)|p[6]
            
            sensor_cache["angle"]["x"] = round(combine_signed(p[8], p[9]) / 32768.0 * 180.0, 2)
            sensor_cache["angle"]["y"] = round(combine_signed(p[10], p[11]) / 32768.0 * 180.0, 2)
            sensor_cache["angle"]["z"] = round(combine_signed(p[12], p[13]) / 32768.0 * 180.0, 2)
            
            sensor_cache["temp"] = round(combine_signed(p[14], p[15]) / 100.0, 1)
            
            sensor_cache["disp"]["x"] = (p[17]<<8)|p[16]
            sensor_cache["disp"]["y"] = (p[19]<<8)|p[18]
            sensor_cache["disp"]["z"] = (p[21]<<8)|p[20]
            
            sensor_cache["freq"]["x"] = (p[23]<<8)|p[22]
            sensor_cache["freq"]["y"] = (p[25]<<8)|p[24]
            sensor_cache["freq"]["z"] = (p[27]<<8)|p[26]
            
            sensor_cache["timestamp"] = time.strftime("%H:%M:%S")
            sensor_cache["status"] = "Conectado"
            
            if csv_logging_active and csv_filename:
                vRms = round(math.sqrt(sensor_cache["vel"]["x"]**2 + sensor_cache["vel"]["y"]**2 + sensor_cache["vel"]["z"]**2), 1)
                dRms = round(math.sqrt(sensor_cache["disp"]["x"]**2 + sensor_cache["disp"]["y"]**2 + sensor_cache["disp"]["z"]**2), 0)
                
                # Filas actualizadas fusionando WTVB01 + MPU6050 (taSMG)
                row = [
                    sensor_cache["timestamp"], sensor_cache["vel"]["x"], sensor_cache["vel"]["y"], sensor_cache["vel"]["z"], vRms,
                    sensor_cache["angle"]["x"], sensor_cache["angle"]["y"], sensor_cache["angle"]["z"], sensor_cache["temp"],
                    sensor_cache["disp"]["x"], sensor_cache["disp"]["y"], sensor_cache["disp"]["z"], dRms,
                    sensor_cache["freq"]["x"], sensor_cache["freq"]["y"], sensor_cache["freq"]["z"], sensor_cache["battery"],
                    tasmg_data["gx"], tasmg_data["gy"], tasmg_data["gz"]  # <- Datos del ESP32 añadidos
                ]
                with open(csv_filename, mode='a', newline='') as f:
                    csv.writer(f).writerow(row)
                
                csv_record_count += 1
            
            ble_buffer = ble_buffer[28:]
        else:
            ble_buffer = ble_buffer[1:]

async def witmotion_loop():
    global sensor_cache
    while True:
        try:
            sensor_cache["status"] = "Buscando WTVB01..."
            devices = await BleakScanner.discover()
            target_device = next((d for d in devices if d.name and "WTVB01" in d.name), None)
            
            if target_device:
                sensor_cache["status"] = "Conectando..."
                async with BleakClient(target_device.address) as client:
                    await client.start_notify(WITMOTION_CHAR_UUID, witmotion_rx_handler)
                    while client.is_connected:
                        await asyncio.sleep(1)
            else:
                sensor_cache["status"] = "No Encontrado"
                await asyncio.sleep(5) 
        except Exception as e:
            sensor_cache["status"] = f"Error BLE: {str(e)}"
            await asyncio.sleep(5)

# =============================================================================
#  MOTOR DE HILOS (SEPARACIÓN ESTRICTA)
# =============================================================================
def arrancar_bluetooth_aislado():
    b_loop = asyncio.new_event_loop()
    asyncio.set_event_loop(b_loop)
    b_loop.run_until_complete(witmotion_loop())

@asynccontextmanager
async def lifespan(app: FastAPI):
    # --- Eventos de Arranque ---
    threading.Thread(target=forzar_reseteo_plc, daemon=True).start()
    threading.Thread(target=background_plc_poller, daemon=True).start()
    threading.Thread(target=esp32_udp_listener, daemon=True).start()
    threading.Thread(target=arrancar_bluetooth_aislado, daemon=True).start()
    yield
    # --- Eventos de Apagado (Opcional) ---
    if plc.get_connected():
        plc.disconnect()
    
app = FastAPI(lifespan=lifespan)

# =============================================================================
#  RUTAS WEB Y API REST
# =============================================================================
@app.get("/")
def serve_index(): return FileResponse("index.html")

@app.get("/sensor_data")
def read_sensor(request: Request):
    respuesta = sensor_cache.copy()
    if respuesta["status"] != "Conectado":
        pitch_rad = math.asin(tasmg_data.get("gx", 0.0))
        roll_rad = math.asin(min(1.0, max(-1.0, -tasmg_data.get("gy", 0.0))))
        
        respuesta["angle"] = {
            "x": round(math.degrees(pitch_rad), 2),
            "y": round(math.degrees(roll_rad), 2),
            "z": 0.0
        }
        
    respuesta["is_logging"] = csv_logging_active
    respuesta["csv_count"] = csv_record_count
    respuesta["tasmg"] = tasmg_data 
    return respuesta

@app.post("/sensor_log/{state}")
def toggle_sensor_log(state: bool, request: Request):
    global csv_logging_active, csv_filename, csv_record_count, tasmg_data
    csv_logging_active = state
    
    if state:
        tasmg_data["sum_x"] = 0.0; tasmg_data["sum_y"] = 0.0; tasmg_data["sum_z"] = 0.0
        tasmg_data["count"] = 0; tasmg_data["taSMG_val"] = 1.0

        csv_record_count = 0 
        
        # Crear directorio si no existe (según tu estructura de carpetas)
        os.makedirs("registros_csv", exist_ok=True)
        # Rutear el archivo a la carpeta registros_csv
        csv_filename = os.path.join("registros_csv", f"telemetria_scada_{int(time.time())}.csv")
        
        with open(csv_filename, mode='w', newline='') as f:
            # Añadidos los 3 ejes del MPU6050 a la cabecera
            f.write("Timestamp,VelX,VelY,VelZ,VelRMS,AngleX,AngleY,AngleZ,Temp,DispX,DispY,DispZ,DispRMS,FreqX,FreqY,FreqZ,Battery,MPU_GX,MPU_GY,MPU_GZ\n")
        return {"status": "OK", "msg": f"Grabando en PC: {csv_filename}"}
    else:
        return {"status": "OK", "msg": "Grabación detenida"}

@app.get("/descargar_csv")
def descargar_ultimo_csv():
    # Buscar dentro del directorio correcto
    archivos_csv = glob.glob(os.path.join("registros_csv", "telemetria_scada_*.csv"))
    if not archivos_csv: return {"status": "ERROR", "msg": "No hay archivos generados aún."}
    ultimo_archivo = max(archivos_csv, key=os.path.getctime)
    return FileResponse(ultimo_archivo, media_type="text/csv", filename=os.path.basename(ultimo_archivo))

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
    if plc.get_connected():
        write_bit(OFFSETS_V90["enable"][0], OFFSETS_V90["enable"][1], state)
        write_bit(OFFSETS_S210["enable"][0], OFFSETS_S210["enable"][1], state)
        return {"status": "OK"}
    return {"status": "OFFLINE"}

@app.post("/motor/start/{state}")
def set_start(state: bool, request: Request):
    if not check_master(request): return {"status": "DENIED"}
    if plc.get_connected():
        write_bit(OFFSETS_V90["start"][0], OFFSETS_V90["start"][1], state)
        write_bit(OFFSETS_S210["start"][0], OFFSETS_S210["start"][1], state)
        return {"status": "OK"}
    return {"status": "OFFLINE"}

@app.post("/control/{motor}/{valor}")
def enviar_velocidad(motor: str, valor: float, request: Request):
    if not check_master(request): return {"status": "DENIED"}
    m = motor.upper()
    if m in estado_deseado: estado_deseado[m]["rpm"] = valor
    if plc.get_connected(): 
        enviar_datos_directos()
        return {"status": "OK"}
    return {"status": "OFFLINE"}

@app.post("/extra/{motor}/{sentido}/{rango}/{torque}")
def enviar_extras(motor: str, sentido: int, rango: float, torque: float, request: Request):
    if not check_master(request): return {"status": "DENIED"}
    m = motor.upper()
    if m in estado_deseado: estado_deseado[m]["dir"] = sentido
    if plc.get_connected():
        off = OFFSETS_V90 if m == "A" else OFFSETS_S210
        write_real(off["rango_aleatorio"], rango)
        write_real(off["limite_torque"], torque)
        enviar_datos_directos()
        return {"status": "OK"}
    return {"status": "OFFLINE"}

@app.post("/emergency")
def stop_total(request: Request):
    estado_deseado["A"]["rpm"] = 0.0; estado_deseado["A"]["dir"] = 1
    estado_deseado["B"]["rpm"] = 0.0; estado_deseado["B"]["dir"] = 1
    forzar_reseteo_plc()
    
    token_control["ip"] = request.client.host
    token_control["ultimo_contacto"] = time.time()
    telemetria_cache["master_ip"] = request.client.host
    return {"msg": "HALT_AND_RESET_COMPLETE"}

app.mount("/img", StaticFiles(directory="img"), name="img")
app.mount("/WTVB01-BT50 - dashboard", StaticFiles(directory="WTVB01-BT50 - dashboard", html=True), name="dashboard")
app.mount("/", StaticFiles(directory=".", html=True), name="static")

if __name__ == "__main__":
    print("[SISTEMA] Motor FastAPI iniciado. Interfaz web lista.")
    logging.getLogger("uvicorn.access").disabled = True
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="warning")
