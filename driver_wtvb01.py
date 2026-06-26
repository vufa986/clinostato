import asyncio
import time
import requests
import queue
import threading
from bleak import BleakClient, BleakScanner

# UUIDs del WitMotion
WITMOTION_SERVICE_UUID = "0000ffe5-0000-1000-8000-00805f9a34fb"
WITMOTION_CHAR_UUID    = "0000ffe4-0000-1000-8000-00805f9a34fb"

API_URL = "http://127.0.0.1:8000/internal/wtvb01"
ble_buffer = bytearray()

# Cola de mensajes para no bloquear el RX Handler
data_queue = queue.Queue()

def combine_signed(low, high):
    val = (high << 8) | low
    return val - 65536 if val >= 32768 else val

# Hilo dedicado exclusivamente a enviar el HTTP POST sin frenar al Bluetooth
def http_sender_worker():
    while True:
        payload = data_queue.get()
        try:
            requests.post(API_URL, json=payload, timeout=1)
        except Exception:
            pass # Ignoramos errores si el servidor SCADA aún no arranca

threading.Thread(target=http_sender_worker, daemon=True).start()

def witmotion_rx_handler(sender, data: bytearray):
    global ble_buffer
    ble_buffer.extend(data)
    
    while len(ble_buffer) >= 28:
        if ble_buffer[0] == 0x55 and ble_buffer[1] == 0x61:
            p = ble_buffer[:28]
            
            payload = {
                "vel": {
                    "x": (p[3]<<8)|p[2], "y": (p[5]<<8)|p[4], "z": (p[7]<<8)|p[6]
                },
                "angle": {
                    "x": round(combine_signed(p[8], p[9]) / 32768.0 * 180.0, 2),
                    "y": round(combine_signed(p[10], p[11]) / 32768.0 * 180.0, 2),
                    "z": round(combine_signed(p[12], p[13]) / 32768.0 * 180.0, 2)
                },
                "temp": round(combine_signed(p[14], p[15]) / 100.0, 1),
                "disp": {
                    "x": (p[17]<<8)|p[16], "y": (p[19]<<8)|p[18], "z": (p[21]<<8)|p[20]
                },
                "freq": {
                    "x": (p[23]<<8)|p[22], "y": (p[25]<<8)|p[24], "z": (p[27]<<8)|p[26]
                },
                "battery": 100,
                "timestamp": time.strftime("%H:%M:%S"),
                "status": "Conectado"
            }
            
            print(f"[BLE] WTVB01 - Pitch: {payload['angle']['x']}° | Roll: {payload['angle']['y']}°")
            
            # Mandamos la data procesada a la cola para que el servidor web la reciba
            data_queue.put(payload)
            ble_buffer = ble_buffer[28:]
        else:
            ble_buffer = ble_buffer[1:]

async def main_loop():
    while True:
        try:
            print("[BLE] Escaneando dispositivos en busca del WTVB01...")
            data_queue.put({"status": "Buscando WTVB01...", "angle": {"x":0,"y":0,"z":0}})
            
            devices = await BleakScanner.discover()
            target = next((d for d in devices if d.name and "WTVB01" in d.name), None)
            
            if target:
                print(f"[BLE] Sensor encontrado: {target.address}. Conectando...")
                data_queue.put({"status": "Conectando...", "angle": {"x":0,"y":0,"z":0}})
                
                async with BleakClient(target.address) as client:
                    await client.start_notify(WITMOTION_CHAR_UUID, witmotion_rx_handler)
                    print("[BLE] Conexión estable. Decodificando telemetría...")
                    
                    while client.is_connected:
                        await asyncio.sleep(1)
            else:
                print("[BLE] No encontrado. Reintentando...")
                await asyncio.sleep(3)
                
        except Exception as e:
            print(f"[BLE] Error: {e}")
            await asyncio.sleep(3)

if __name__ == "__main__":
    asyncio.run(main_loop())