from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
import snap7
from snap7.util import set_bool, set_real, set_int, get_real, get_bool, get_int
from snap7.type import Areas
import time
import uvicorn
import threading

PLC_IP = "192.168.0.1"
DB_NUMBER = 3

plc_lock = threading.Lock()
app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

plc = snap7.client.Client()

estado_deseado = {
    "A": {"rpm": 0.0, "dir": 1},
    "B": {"rpm": 0.0, "dir": 1}
}

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

def conectar_seguro():
    with plc_lock: 
        if not plc.get_connected():
            try:
                plc.disconnect() 
                plc.connect(PLC_IP, 0, 1)
            except Exception as e:
                print(f"🔴 EL PLC RECHAZÓ LA CONEXIÓN: {e}")

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
            plc.disconnect()
            return False

def read_real(byte_idx):
    with plc_lock:
        if not plc.get_connected(): return 0.0
        try:
            data = plc.read_area(Areas.DB, DB_NUMBER, byte_idx, 4)
            return get_real(data, 0)
        except Exception:
            plc.disconnect()
            return 0.0

def read_int(byte_idx):
    with plc_lock:
        if not plc.get_connected(): return 0
        try:
            data = plc.read_area(Areas.DB, DB_NUMBER, byte_idx, 2)
            return get_int(data, 0)
        except Exception:
            plc.disconnect()
            return 0

def enviar_datos_directos():
    """Toma el valor exacto de la interfaz y lo inyecta sin procesar matemáticamente"""
    if not plc.get_connected(): return

    rpm_A = estado_deseado["A"]["rpm"]
    dir_A = estado_deseado["A"]["dir"]
    
    rpm_B = estado_deseado["B"]["rpm"]
    dir_B = estado_deseado["B"]["dir"]

    # Inyección directa a V90
    write_real(OFFSETS_V90["speed_rpm"], rpm_A)
    write_int(OFFSETS_V90["sentido"], dir_A)
    write_real(OFFSETS_V90["speed_hacia"], rpm_A if dir_A == 1 else -rpm_A)
    
    # Inyección directa a S210
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

@app.get("/")
def serve_index(): return FileResponse("index.html")

@app.get("/telemetry")
def read_telemetry():
    conectar_seguro()
    if not plc.get_connected(): return {"status": "OFFLINE"}
    return {"v90": leer_parametros(OFFSETS_V90), "s210": leer_parametros(OFFSETS_S210), "status": "OK"}

@app.post("/motor/power/{state}")
def set_power(state: bool):
    conectar_seguro()
    if plc.get_connected():
        write_bit(OFFSETS_V90["enable"][0], OFFSETS_V90["enable"][1], state)
        write_bit(OFFSETS_S210["enable"][0], OFFSETS_S210["enable"][1], state)
    return {"status": "OK" if plc.get_connected() else "OFFLINE"}

@app.post("/motor/start/{state}")
def set_start(state: bool):
    conectar_seguro()
    if plc.get_connected():
        write_bit(OFFSETS_V90["start"][0], OFFSETS_V90["start"][1], state)
        write_bit(OFFSETS_S210["start"][0], OFFSETS_S210["start"][1], state)
    return {"status": "OK" if plc.get_connected() else "OFFLINE"}

@app.post("/control/{motor}/{valor}")
def enviar_velocidad(motor: str, valor: float):
    conectar_seguro()
    m = motor.upper()
    if m in estado_deseado: estado_deseado[m]["rpm"] = valor
    if plc.get_connected(): enviar_datos_directos()
    return {"status": "OK"}

@app.post("/extra/{motor}/{sentido}/{rango}/{torque}")
def enviar_extras(motor: str, sentido: int, rango: float, torque: float):
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
def stop_total():
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
    return {"msg": "HALT_AND_RESET_COMPLETE"}

app.mount("/img", StaticFiles(directory="img"), name="img")
app.mount("/", StaticFiles(directory=".", html=True), name="static")

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)