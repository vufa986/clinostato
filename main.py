from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import snap7
from snap7.util import set_bool, set_real, get_bool
from snap7.type import Areas
import time
import uvicorn

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

PLC_IP = "192.168.0.1"
plc = snap7.client.Client()

def conectar_seguro():
    if not plc.get_connected():
        try:
            plc.connect(PLC_IP, 0, 1)
            print("🔗 BIO-LINK: Conexión establecida con DB3")
        except Exception as e:
            print(f"⚠️ ERROR DE CONEXIÓN SNAP7: {e}")

@app.get("/")
def estado_sistema():
    return {"status": "BioX API Online", "system": "Clinoestato"}

@app.post("/motor/power/{state}")
def set_power(state: bool):
    conectar_seguro()
    if plc.get_connected():
        # V90 (Motor A) Power: DB3.DBX0.0
        data_v90 = plc.read_area(Areas.DB, 3, 0, 1)
        set_bool(data_v90, 0, 0, state)
        plc.write_area(Areas.DB, 3, 0, data_v90)

        # S210 (Motor B) Power: DB3.DBX6.0
        data_s210 = plc.read_area(Areas.DB, 3, 6, 1)
        set_bool(data_s210, 0, 0, state)
        plc.write_area(Areas.DB, 3, 6, data_s210)
        
        return {"status": f"Power {'ON' if state else 'OFF'}"}
    return {"status": "PLC_OFFLINE"}

@app.post("/motor/start/{state}")
def set_start(state: bool):
    conectar_seguro()
    if plc.get_connected():
        # V90 (Motor A) Start: DB3.DBX0.2
        data_v90 = plc.read_area(Areas.DB, 3, 0, 1)
        set_bool(data_v90, 0, 2, state)
        plc.write_area(Areas.DB, 3, 0, data_v90)

        # S210 (Motor B) Start: DB3.DBX6.2
        data_s210 = plc.read_area(Areas.DB, 3, 6, 1)
        set_bool(data_s210, 0, 2, state)
        plc.write_area(Areas.DB, 3, 6, data_s210)
        
        return {"status": f"Engine {'RUN' if state else 'STOP'}"}
    return {"status": "PLC_OFFLINE"}

@app.post("/control/{motor}/{valor}")
def enviar_velocidad(motor: str, valor: float):
    conectar_seguro()
    if plc.get_connected():
        # Buffer de 4 bytes para variables Real (32 bits)
        buffer = bytearray(4)
        set_real(buffer, 0, valor)

        if motor == "A":
            # 1. Escribir velocidad en DB3.DBD2
            plc.write_area(Areas.DB, 3, 2, buffer)
            
            # 2. Doble Flanco para V90 (DB3.DBX0.2)
            data_start = plc.read_area(Areas.DB, 3, 0, 1)
            if get_bool(data_start, 0, 2):  # Solo si el motor ya está corriendo
                set_bool(data_start, 0, 2, False)
                plc.write_area(Areas.DB, 3, 0, data_start)
                time.sleep(0.05)
                set_bool(data_start, 0, 2, True)
                plc.write_area(Areas.DB, 3, 0, data_start)

        elif motor == "B":
            # 1. Escribir velocidad en DB3.DBD8
            plc.write_area(Areas.DB, 3, 8, buffer)
            
            # 2. Doble Flanco para S210 (DB3.DBX6.2)
            data_start = plc.read_area(Areas.DB, 3, 6, 1)
            if get_bool(data_start, 0, 2):  # Solo si el motor ya está corriendo
                set_bool(data_start, 0, 2, False)
                plc.write_area(Areas.DB, 3, 6, data_start)
                time.sleep(0.05)
                set_bool(data_start, 0, 2, True)
                plc.write_area(Areas.DB, 3, 6, data_start)

        return {"msg": "OK", "rpm": valor}
    return {"msg": "OFFLINE"}

@app.get("/telemetria")
def leer_telemetria():
    conectar_seguro()
    return {"status": "ACTIVE" if plc.get_connected() else "DEMO", "temp": 24.5}

@app.post("/emergency")
def stop_total():
    conectar_seguro()
    if plc.get_connected():
        # Parada de Emergencia V90 (Byte 0)
        data_v90 = plc.read_area(Areas.DB, 3, 0, 1)
        set_bool(data_v90, 0, 0, False) # Apagar Enable
        set_bool(data_v90, 0, 2, False) # Apagar Execute
        plc.write_area(Areas.DB, 3, 0, data_v90)
        
        # Parada de Emergencia S210 (Byte 6)
        data_s210 = plc.read_area(Areas.DB, 3, 6, 1)
        set_bool(data_s210, 0, 0, False) # Apagar Enable
        set_bool(data_s210, 0, 2, False) # Apagar Execute
        plc.write_area(Areas.DB, 3, 6, data_s210)
        
    return {"msg": "HALT"}

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)