from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from contextlib import asynccontextmanager
import snap7
from snap7.util import set_bool, set_real, set_dint, get_real, get_bool, get_dint
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
import socket
import json
import sys
import logging

# =============================================================================
#  CONFIGURACIÓN GLOBAL Y LOGS
# =============================================================================
PLC_IP = "192.168.0.1"
DB_NUMBER = 3

WITMOTION_SERVICE_UUID = "0000ffe5-0000-1000-8000-00805f9a34fb"
WITMOTION_CHAR_UUID    = "0000ffe4-0000-1000-8000-00805f9a34fb"

plc_lock = threading.Lock()
LOCK_TIMEOUT = 0.3  

LOG_FORMAT = "%(asctime)s [%(levelname)s] %(message)s"
logger = logging.getLogger("NexusSCADA")
DEBUG_MODE = False

if DEBUG_MODE:
    logging.basicConfig(level=logging.DEBUG, format=LOG_FORMAT)
else:
    logging.basicConfig(level=logging.INFO, format=LOG_FORMAT, handlers=[
        logging.FileHandler("debug.log", encoding="utf-8"),
        logging.StreamHandler(sys.stdout)
    ])
logging.getLogger("snap7").setLevel(logging.WARNING)

# =============================================================================
#  VARIABLES GLOBALES Y MAPA DE MEMORIA (32-Bit DInt)
# =============================================================================
tasmg_data = {
    "sum_x": 0.0, "sum_y": 0.0, "sum_z": 0.0,
    "count": 0,
    "taSMG_val": 1.0, 
    "gx": 0.0, "gy": 0.0, "gz": -1.0
}

# --- EXPANDIDO PARA RECORDAR EL TORQUE Y EL RANGO ---
estado_deseado = {
    "A": {"rpm": 0.0, "dir": 1, "rango": 0.0, "torque": 0.0},
    "B": {"rpm": 0.0, "dir": 1, "rango": 0.0, "torque": 0.0}
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

# MAPA ACTUALIZADO (DB3 en TIA Portal usa DInt para "Sentido")
OFFSETS_V90 = {
    "start": (0, 0), "enable": (6, 0), "reset_alarm": (6, 1),
    "speed_rpm": 2, "speed_hacia": 8, "sentido": 12, 
    "rango_aleatorio": 16, "limite_torque": 20 
}

OFFSETS_S210 = {
    "start": (24, 0), "enable": (30, 0), "reset_alarm": (30, 1),
    "speed_rpm": 26, "speed_hacia": 32, "sentido": 36, 
    "rango_aleatorio": 40, "limite_torque": 44 
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
contador_ble = 0

plc = snap7.client.Client()

# =============================================================================
#  FUNCIONES DE COMUNICACIÓN PLC (SNAP7)
# =============================================================================
def conectar_seguro():
    if plc.get_connected(): return True
    
    if plc_lock.acquire(timeout=1.0): 
        try:
            if not plc.get_connected():
                plc.disconnect()
                time.sleep(0.2)
                plc.connect(PLC_IP, 0, 1)
                if plc.get_connected():
                    logger.info(f"[PLC] Enlace TCP/ISO establecido con {PLC_IP}")
        except Exception as e:
            err_str = str(e)
            if "10061" in err_str:
                logger.error("[PLC] Conexión rechazada (WinError 10061). Verifica: 1) PLC en RUN. 2) 'PUT/GET' habilitado en TIA Portal. 3) Desconecta TIA Portal (Go Offline).")
            else:
                logger.error(f"[PLC] Fallo físico de conexión: {e}")
        finally:
            plc_lock.release()
    return plc.get_connected()

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
                buf = bytearray(4)  # 32-bits (DInt)
                set_dint(buf, 0, int(val))
                plc.write_area(Areas.DB, DB_NUMBER, byte_idx, buf)
        except Exception as e:
            logger.error(f"[PLC-WRITE] Error en offset {byte_idx}: {e}")
            plc.disconnect()
        finally:
            plc_lock.release()

def enviar_datos_directos():
    if not plc.get_connected(): return
    
    rpm_A = estado_deseado["A"]["rpm"]
    dir_A = estado_deseado["A"]["dir"]
    rpm_B = estado_deseado["B"]["rpm"]
    dir_B = estado_deseado["B"]["dir"]

    write_real(OFFSETS_V90["speed_rpm"], rpm_A)
    write_int(OFFSETS_V90["sentido"], dir_A)
    write_real(OFFSETS_V90["speed_hacia"], rpm_A if dir_A == 1 else -rpm_A)
    
    write_real(OFFSETS_S210["speed_rpm"], rpm_B)
    write_int(OFFSETS_S210["sentido"], dir_B)
    write_real(OFFSETS_S210["speed_hacia"], rpm_B if dir_B == 1 else -rpm_B)

def forzar_reseteo_plc():
    """Ejecuta el Handshake de limpieza de memorias PLC (Ahora resetea también Torque y Rango)"""
    logger.info("[SISTEMA] Esperando conexión con el PLC para Handshake inicial...")
    intentos = 0
    while not plc.get_connected() and intentos < 10:
        time.sleep(1)
        intentos += 1
        
    if plc.get_connected():
        logger.info("[SISTEMA] Ejecutando Handshake de limpieza de memorias PLC...")
        
        # Sincronizamos la memoria interna (Web Target) a Cero absoluto
        estado_deseado["A"] = {"rpm": 0.0, "dir": 1, "rango": 0.0, "torque": 0.0}
        estado_deseado["B"] = {"rpm": 0.0, "dir": 1, "rango": 0.0, "torque": 0.0}
        
        for off in [OFFSETS_V90, OFFSETS_S210]:
            write_bit(off["start"][0], off["start"][1], False)
            write_bit(off["enable"][0], off["enable"][1], False)
            write_real(off["speed_rpm"], 0.0)
            write_real(off["speed_hacia"], 0.0)
            write_real(off["rango_aleatorio"], 0.0) # Aseguramos reseteo
            write_real(off["limite_torque"], 0.0)   # Aseguramos reseteo
            write_int(off["sentido"], 1)
            write_bit(off["reset_alarm"][0], off["reset_alarm"][1], True)
        
        time.sleep(0.5)
        for off in [OFFSETS_V90, OFFSETS_S210]: 
            write_bit(off["reset_alarm"][0], off["reset_alarm"][1], False)
        logger.info("[SISTEMA] PLC reseteado exitosamente. Listo para operar.")
    else:
        logger.error("[ERROR] Imposible ejecutar Handshake inicial. PLC desconectado.")

def background_plc_poller():
    """Poller optimizado de lectura en bloque"""
    time.sleep(2) 
    while True:
        if conectar_seguro():
            try:
                with plc_lock:
                    buffer_db = plc.read_area(Areas.DB, DB_NUMBER, 0, 48)
                
                telemetria_cache["v90"] = {
                    "Arrancar": get_bool(buffer_db, 0, 0),
                    "Activar": get_bool(buffer_db, 6, 0),
                    "Reset_Alarm": get_bool(buffer_db, 6, 1),
                    "Velocidad": get_real(buffer_db, 2),
                    "Velocidad_Hacia": get_real(buffer_db, 8),
                    "Sentido": get_dint(buffer_db, 12),
                    "Rango_Aleatorio": get_real(buffer_db, 16),
                    "Limite_Torque": get_real(buffer_db, 20)
                }
                
                telemetria_cache["s210"] = {
                    "Arrancar": get_bool(buffer_db, 24, 0),
                    "Activar": get_bool(buffer_db, 30, 0),
                    "Reset_Alarm": get_bool(buffer_db, 30, 1),
                    "Velocidad": get_real(buffer_db, 26),
                    "Velocidad_Hacia": get_real(buffer_db, 32),
                    "Sentido": get_dint(buffer_db, 36),
                    "Rango_Aleatorio": get_real(buffer_db, 40),
                    "Limite_Torque": get_real(buffer_db, 44)
                }
                telemetria_cache["status"] = "OK"
            except Exception as e:
                telemetria_cache["status"] = "ERROR"
                logger.error(f"[PLC-READ] Error bloque DB{DB_NUMBER}: {e}")
        else:
            telemetria_cache["status"] = "OFFLINE"
        
        time.sleep(0.15)

# =============================================================================
#  SENSORES (UDP Y BLE)
# =============================================================================
def esp32_udp_listener():
    global tasmg_data, csv_logging_active
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("0.0.0.0", 8001))
    contador_udp = 0
    
    while True:
        try:
            data, addr = sock.recvfrom(1024) 
            texto_recibido = data.decode('utf-8', errors='ignore').strip()
            
            if "{" in texto_recibido and "}" in texto_recibido:
                inicio = texto_recibido.find("{")
                fin = texto_recibido.rfind("}") + 1
                payload = json.loads(texto_recibido[inicio:fin])
                
                pitch_rad = math.radians(float(payload.get("pitch", 0.0)))
                roll_rad  = math.radians(float(payload.get("roll", 0.0)))
                
                gx = math.cos(roll_rad) * math.sin(pitch_rad)
                gy = -math.sin(roll_rad)
                gz = -(math.cos(roll_rad) * math.cos(pitch_rad))
                
                tasmg_data.update({"gx": gx, "gy": gy, "gz": gz})
                
                if csv_logging_active:
                    tasmg_data["sum_x"] += gx
                    tasmg_data["sum_y"] += gy
                    tasmg_data["sum_z"] += gz
                    tasmg_data["count"] += 1
                    tasmg_data["taSMG_val"] = math.sqrt(
                        (tasmg_data["sum_x"]/tasmg_data["count"])**2 + 
                        (tasmg_data["sum_y"]/tasmg_data["count"])**2 + 
                        (tasmg_data["sum_z"]/tasmg_data["count"])**2
                    )
                
                contador_udp += 1
                if contador_udp >= 50:
                    logger.info(f"[SENSOR-UDP] Paquete MPU6050 procesado (gx: {gx:.2f})")
                    contador_udp = 0
        except Exception:
            pass

def combine(low, high):
    return (high << 8) | low

def combine_signed(low, high):
    v = (high << 8) | low
    return v - 65536 if v >= 32768 else v

def witmotion_rx_handler(sender, data: bytearray):
    global ble_buffer, sensor_cache, csv_logging_active, csv_filename, csv_record_count, contador_ble
    ble_buffer.extend(data)
    
    while len(ble_buffer) >= 28:
        if ble_buffer[0] == 0x55 and ble_buffer[1] == 0x61:
            p = ble_buffer[:28]
            
            sensor_cache["vel"] = {
                "x": combine(p[2], p[3]), 
                "y": combine(p[4], p[5]), 
                "z": combine(p[6], p[7])
            }
            
            sensor_cache["angle"] = {
                "x": round(combine_signed(p[8], p[9]) / 32768.0 * 180.0, 2),
                "y": round(combine_signed(p[10], p[11]) / 32768.0 * 180.0, 2),
                "z": round(combine_signed(p[12], p[13]) / 32768.0 * 180.0, 2)
            }
            
            sensor_cache["temp"] = round(combine_signed(p[14], p[15]) / 100.0, 1)
            
            sensor_cache["disp"] = {
                "x": combine(p[16], p[17]), 
                "y": combine(p[18], p[19]), 
                "z": combine(p[20], p[21])
            }
            
            sensor_cache["freq"] = {
                "x": combine(p[22], p[23]), 
                "y": combine(p[24], p[25]), 
                "z": combine(p[26], p[27])
            }
            
            sensor_cache["timestamp"] = time.strftime("%H:%M:%S")
            sensor_cache["status"] = "Conectado"
            
            contador_ble += 1
            if contador_ble >= 20:
                logger.info(f"[SENSOR-BLE] Trama WTVB01 procesada (Pitch: {sensor_cache['angle']['x']}°)")
                contador_ble = 0
            
            if csv_logging_active and csv_filename:
                vRms = round(math.sqrt(
                    sensor_cache["vel"]["x"]**2 + 
                    sensor_cache["vel"]["y"]**2 + 
                    sensor_cache["vel"]["z"]**2
                ), 1)
                
                dRms = round(math.sqrt(
                    sensor_cache["disp"]["x"]**2 + 
                    sensor_cache["disp"]["y"]**2 + 
                    sensor_cache["disp"]["z"]**2
                ), 0)
                
                row = [
                    sensor_cache["timestamp"],
                    sensor_cache["vel"]["x"], sensor_cache["vel"]["y"], sensor_cache["vel"]["z"], vRms,
                    sensor_cache["angle"]["x"], sensor_cache["angle"]["y"], sensor_cache["angle"]["z"],
                    sensor_cache["temp"],
                    sensor_cache["disp"]["x"], sensor_cache["disp"]["y"], sensor_cache["disp"]["z"], dRms,
                    sensor_cache["freq"]["x"], sensor_cache["freq"]["y"], sensor_cache["freq"]["z"],
                    sensor_cache["battery"],
                    tasmg_data["gx"], tasmg_data["gy"], tasmg_data["gz"]
                ]
                
                with open(csv_filename, mode='a', newline='') as f:
                    csv.writer(f).writerow(row)
                csv_record_count += 1
            
            ble_buffer = ble_buffer[28:]
        else:
            ble_buffer = ble_buffer[1:]

async def witmotion_loop():
    while True:
        try:
            devices = await BleakScanner.discover()
            target = next((d for d in devices if d.name and "WTVB01" in d.name), None)
            if target:
                async with BleakClient(target.address) as client:
                    await client.start_notify(WITMOTION_CHAR_UUID, witmotion_rx_handler)
                    while client.is_connected:
                        await asyncio.sleep(1)
            await asyncio.sleep(3) 
        except Exception:
            await asyncio.sleep(3)

def arrancar_bluetooth_aislado():
    b_loop = asyncio.new_event_loop()
    asyncio.set_event_loop(b_loop)
    b_loop.run_until_complete(witmotion_loop())

# =============================================================================
#  FUNCIONES AUXILIARES
# =============================================================================
def get_client_ip(request: Request) -> str:
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host

def check_master(request: Request) -> bool:
    ip = get_client_ip(request)
    ahora = time.time()
    if token_control["ip"] is None or (ahora - token_control["ultimo_contacto"] > TIMEOUT_MASTER):
        token_control["ip"] = ip
        telemetria_cache["master_ip"] = ip
    if token_control["ip"] == ip:
        token_control["ultimo_contacto"] = ahora
        return True
    return False

# =============================================================================
#  RUTAS WEB Y API REST (FASTAPI LIFESPAN)
# =============================================================================
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Eventos de arranque
    threading.Thread(target=forzar_reseteo_plc, daemon=True).start()
    threading.Thread(target=background_plc_poller, daemon=True).start()
    threading.Thread(target=esp32_udp_listener, daemon=True).start()
    threading.Thread(target=arrancar_bluetooth_aislado, daemon=True).start()
    yield
    # Eventos de apagado
    if plc.get_connected():
        plc.disconnect()

app = FastAPI(lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
def serve_index():
    return FileResponse("index.html")

@app.get("/telemetry")
def read_telemetry(request: Request):
    ip = get_client_ip(request)
    res = telemetria_cache.copy()
    
    # Exponemos el estado deseado (Target) a la web y al depurador
    res["target"] = estado_deseado
    
    if token_control["ip"] == ip:
        res["is_master"] = True
    elif token_control["ip"] is None:
        res["is_master"] = None
    else:
        res["is_master"] = False
    return res

@app.post("/motor/power/{state}")
def set_power(state: bool, request: Request):
    if not check_master(request):
        return {"status": "DENIED"}
    if plc.get_connected():
        write_bit(OFFSETS_V90["enable"][0], OFFSETS_V90["enable"][1], state)
        write_bit(OFFSETS_S210["enable"][0], OFFSETS_S210["enable"][1], state)
        return {"status": "OK"}
    return {"status": "OFFLINE"}

@app.post("/motor/start/{state}")
def set_start(state: bool, request: Request):
    if not check_master(request):
        return {"status": "DENIED"}
    if plc.get_connected():
        write_bit(OFFSETS_V90["start"][0], OFFSETS_V90["start"][1], state)
        write_bit(OFFSETS_S210["start"][0], OFFSETS_S210["start"][1], state)
        return {"status": "OK"}
    return {"status": "OFFLINE"}

@app.post("/control/{motor}/{valor}")
def enviar_velocidad(motor: str, valor: float, request: Request):
    if not check_master(request):
        return {"status": "DENIED"}
    m = motor.upper()
    if m in estado_deseado:
        estado_deseado[m]["rpm"] = valor
    if plc.get_connected():
        enviar_datos_directos()
    return {"status": "OK"}

@app.post("/extra/{motor}/{sentido}/{rango}/{torque}")
def enviar_extras(motor: str, sentido: int, rango: float, torque: float, request: Request):
    if not check_master(request):
        return {"status": "DENIED"}
    m = motor.upper()
    if m in estado_deseado:
        estado_deseado[m]["dir"] = sentido
        estado_deseado[m]["rango"] = rango    # Memoria en Python para el Depurador
        estado_deseado[m]["torque"] = torque  # Memoria en Python para el Depurador
    if plc.get_connected():
        off = OFFSETS_V90 if m == "A" else OFFSETS_S210
        write_real(off["rango_aleatorio"], rango)
        write_real(off["limite_torque"], torque)
        enviar_datos_directos()
    return {"status": "OK"}

@app.post("/emergency")
def stop_total(request: Request):
    # 1. Reiniciamos toda la memoria local (TARGET)
    estado_deseado["A"] = {"rpm": 0.0, "dir": 1, "rango": 0.0, "torque": 0.0}
    estado_deseado["B"] = {"rpm": 0.0, "dir": 1, "rango": 0.0, "torque": 0.0}
    
    # 2. Hilo aparte (Background Thread)
    # Evitamos bloquear la petición HTTP y causar el crasheo de la interfaz web
    threading.Thread(target=forzar_reseteo_plc, daemon=True).start()
    
    token_control["ip"] = request.client.host
    token_control["ultimo_contacto"] = time.time()
    telemetria_cache["master_ip"] = request.client.host
    return {"msg": "EMERGENCY_TRIGGERED"}

@app.get("/sensor_data")
def read_sensor():
    res = sensor_cache.copy()
    if res["status"] != "Conectado":
        res["angle"] = {
            "x": round(math.degrees(math.asin(max(-1.0, min(1.0, tasmg_data.get("gx", 0.0))))), 2),
            "y": round(math.degrees(math.asin(min(1.0, max(-1.0, -tasmg_data.get("gy", 0.0))))), 2),
            "z": 0.0
        }
    res["is_logging"] = csv_logging_active
    res["csv_count"] = csv_record_count
    res["tasmg"] = tasmg_data 
    return res

@app.post("/sensor_log/{state}")
def toggle_sensor_log(state: bool):
    global csv_logging_active, csv_filename, csv_record_count, tasmg_data
    csv_logging_active = state
    if state:
        tasmg_data["sum_x"] = 0.0
        tasmg_data["sum_y"] = 0.0
        tasmg_data["sum_z"] = 0.0
        tasmg_data["count"] = 0
        tasmg_data["taSMG_val"] = 1.0
        csv_record_count = 0 
        os.makedirs("registros_csv", exist_ok=True)
        csv_filename = os.path.join("registros_csv", f"telemetria_{int(time.time())}.csv")
        with open(csv_filename, mode='w', newline='') as f:
            f.write("Timestamp,VelX,VelY,VelZ,VelRMS,AngleX,AngleY,AngleZ,Temp,DispX,DispY,DispZ,DispRMS,FreqX,FreqY,FreqZ,Battery,MPU_GX,MPU_GY,MPU_GZ\n")
        return {"status": "OK"}
    return {"status": "STOPPED"}

@app.get("/descargar_csv")
def descargar_ultimo_csv():
    archivos_csv = glob.glob(os.path.join("registros_csv", "telemetria_*.csv"))
    if not archivos_csv:
        return {"status": "ERROR", "msg": "No hay archivos generados aún."}
    ultimo_archivo = max(archivos_csv, key=os.path.getctime)
    return FileResponse(ultimo_archivo, media_type="text/csv", filename=os.path.basename(ultimo_archivo))

app.mount("/img", StaticFiles(directory="img"), name="img")
app.mount("/WTVB01-BT50 - dashboard", StaticFiles(directory="WTVB01-BT50 - dashboard", html=True), name="dashboard")
app.mount("/", StaticFiles(directory=".", html=True), name="static")

if __name__ == "__main__":
    logger.info("[SISTEMA] Motor FastAPI SCADA iniciado.")
    logging.getLogger("uvicorn.access").disabled = True
    uvicorn.run("main:app", host="0.0.0.0", port=8000, log_level="warning")