from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
import snap7
from snap7.util import set_bool, set_real, set_int, get_real
from snap7.type import Areas
import time
import uvicorn
import threading

# Configuración PLC
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

# --- ESTADO GLOBAL DESEADO (Marco Absoluto del Dashboard) ---
estado_deseado = {
    "A": {"rpm": 0.0, "dir": 1}, # Eje X (Marco Externo)
    "B": {"rpm": 0.0, "dir": 1}  # Eje Y (Marco Interno)
}

def conectar_seguro():
    if not plc.get_connected():
        try:
            plc.connect(PLC_IP, 0, 1)
        except: pass

def write_bit(byte_idx, bit_idx, val):
    with plc_lock:
        try:
            data = plc.read_area(Areas.DB, DB_NUMBER, byte_idx, 1)
            set_bool(data, 0, bit_idx, val)
            plc.write_area(Areas.DB, DB_NUMBER, byte_idx, data)
        except: pass

def write_real(byte_idx, val):
    with plc_lock:
        try:
            buf = bytearray(4)
            set_real(buf, 0, float(val))
            plc.write_area(Areas.DB, DB_NUMBER, byte_idx, buf)
        except: pass

def write_int(byte_idx, val):
    with plc_lock:
        try:
            buf = bytearray(2)
            set_int(buf, 0, int(val))
            plc.write_area(Areas.DB, DB_NUMBER, byte_idx, buf)
        except: pass

# --- NÚCLEO CINEMÁTICO DE DESACOPLAMIENTO ---
def actualizar_cinematica():
    """
    Calcula e inyecta las velocidades reales físicas al PLC basándose
    en la relación: W_int = W_ext + V_servo_int -> V_servo_int = W_int - W_ext
    """
    if not plc.get_connected():
        return

    # 1. Asignar signos según el sentido deseado (1 = Horario (+), 2 = Antihorario (-))
    signo_ext = 1.0 if estado_deseado["A"]["dir"] == 1 else -1.0
    w_ext = estado_deseado["A"]["rpm"] * signo_ext
    
    signo_int = 1.0 if estado_deseado["B"]["dir"] == 1 else -1.0
    w_int = estado_deseado["B"]["rpm"] * signo_int
    
    # 2. Aplicar fórmulas de compensación para los servos
    v_servo_ext = w_ext
    v_servo_int = w_int - w_ext
    
    # 3. Convertir de nuevo a magnitudes (RPM absolutos) y sentidos físicos (1 o 2)
    rpm_out_A = abs(v_servo_ext)
    dir_out_A = 1 if v_servo_ext >= 0 else 2
    
    rpm_out_B = abs(v_servo_int)
    dir_out_B = 1 if v_servo_int >= 0 else 2
    
    # 4. Enviar comandos físicos compensados al PLC
    # Actuador Externo (V90)
    write_real(2, rpm_out_A)
    write_int(12, dir_out_A)
    
    # Actuador Interno (S210)
    write_real(24, rpm_out_B)
    write_int(34, dir_out_B)

# Rutas de la API
@app.get("/")
def serve_index():
    return FileResponse("index.html")

@app.get("/telemetry")
def read_telemetry():
    conectar_seguro()
    if not plc.get_connected():
        return {"v90_mv": 0.0, "s210_mv": 0.0, "status": "OFFLINE"}
    
    with plc_lock:
        try:
            data_v90 = plc.read_area(Areas.DB, DB_NUMBER, 8, 4)
            v90_mv = get_real(data_v90, 0)
            
            data_s210 = plc.read_area(Areas.DB, DB_NUMBER, 30, 4)
            s210_mv = get_real(data_s210, 0)
            
            return {"v90_mv": v90_mv, "s210_mv": s210_mv, "status": "OK"}
        except Exception as e:
            return {"v90_mv": 0.0, "s210_mv": 0.0, "status": "ERROR"}

@app.post("/motor/power/{state}")
def set_power(state: bool):
    conectar_seguro()
    if plc.get_connected():
        write_bit(6, 0, state); write_bit(28, 0, state)  
        return {"status": "OK"}
    return {"status": "OFFLINE"}

@app.post("/motor/start/{state}")
def set_start(state: bool):
    conectar_seguro()
    if plc.get_connected():
        write_bit(0, 0, state); write_bit(22, 0, state)  
        return {"status": "OK"}
    return {"status": "OFFLINE"}

@app.post("/control/{motor}/{valor}")
def enviar_velocidad(motor: str, valor: float):
    conectar_seguro()
    m = motor.upper()
    if m in estado_deseado:
        estado_deseado[m]["rpm"] = valor
        
    if plc.get_connected():
        actualizar_cinematica() # Recalcula y dispara la escritura de ambos ejes
        return {"msg": "OK"}
    return {"msg": "OFFLINE"}

@app.post("/extra/{motor}/{sentido}/{rango}/{torque}")
def enviar_extras(motor: str, sentido: int, rango: float, torque: float):
    conectar_seguro()
    m = motor.upper()
    if m in estado_deseado:
        estado_deseado[m]["dir"] = sentido

    if plc.get_connected():
        # Escribimos los parámetros directos que no afectan la cinemática
        if m == "A":
            write_real(14, rango); write_real(18, torque)
        else:
            write_real(36, rango); write_real(40, torque)
            
        # Actualizamos la cinemática porque un cambio de sentido afecta la compensación
        actualizar_cinematica()
        return {"msg": "OK"}
    return {"msg": "OFFLINE"}

@app.post("/emergency")
def stop_total():
    conectar_seguro()
    # Limpiamos el estado deseado en memoria
    estado_deseado["A"]["rpm"] = 0.0; estado_deseado["A"]["dir"] = 1
    estado_deseado["B"]["rpm"] = 0.0; estado_deseado["B"]["dir"] = 1

    if plc.get_connected():
        write_bit(0, 0, False); write_bit(22, 0, False)
        write_bit(6, 0, False); write_bit(28, 0, False)
        write_real(2, 0.0); write_real(24, 0.0)
        write_real(14, 0.0); write_real(36, 0.0)
        write_real(18, 0.0); write_real(40, 0.0)
        write_int(12, 1); write_int(34, 1)
        write_bit(6, 1, True); write_bit(28, 1, True)
        time.sleep(0.5)
        write_bit(6, 1, False); write_bit(28, 1, False)
    return {"msg": "HALT_AND_RESET_COMPLETE"}

# Montaje de archivos estáticos
app.mount("/img", StaticFiles(directory="img"), name="img")
app.mount("/", StaticFiles(directory=".", html=True), name="static")

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)