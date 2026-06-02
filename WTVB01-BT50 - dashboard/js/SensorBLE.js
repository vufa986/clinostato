export class WitMotionBLE {
    constructor(onDataReceived, onDisconnect) {
        this.SERVICE_UUID = '0000ffe5-0000-1000-8000-00805f9a34fb';
        this.CHAR_UUID    = '0000ffe4-0000-1000-8000-00805f9a34fb';
        this.device = null;
        this.characteristic = null;
        this.buffer = new Uint8Array();
        this.onDataReceived = onDataReceived; 
        this.onDisconnect = onDisconnect;     
    }

    async connect() {
        this.device = await navigator.bluetooth.requestDevice({
            acceptAllDevices: true,
            optionalServices: [this.SERVICE_UUID]
        });

        this.device.addEventListener('gattserverdisconnected', () => {
            if (this.onDisconnect) this.onDisconnect();
        });

        const server = await this.device.gatt.connect();
        const service = await server.getPrimaryService(this.SERVICE_UUID);
        this.characteristic = await service.getCharacteristic(this.CHAR_UUID);

        await this.characteristic.startNotifications();
        this.characteristic.addEventListener('characteristicvaluechanged', (e) => this.handleStream(e));
        
        return this.device.name || "WTVB01-BT50";
    }

    disconnect() {
        if (this.device && this.device.gatt.connected) {
            this.device.gatt.disconnect();
        }
    }

    // --- NUEVO: MÉTODO PARA ENVIAR COMANDOS PROTOCOLARIOS AL SENSOR ---
    async sendCommand(cmdArray) {
        if (!this.characteristic) {
            throw new Error("El sensor no está listo para recibir comandos.");
        }
        const payload = new Uint8Array(cmdArray);
        try {
            // WitMotion BLE atiende escrituras de comandos sobre el mismo endpoint FFE4
            if (this.characteristic.properties.writeWithoutResponse) {
                await this.characteristic.writeValueWithoutResponse(payload);
            } else {
                await this.characteristic.writeValue(payload);
            }
        } catch (error) {
            console.error("Error al transmitir comando BLE:", error);
            throw error;
        }
    }

    handleStream(event) {
        const incoming = new Uint8Array(event.target.value.buffer);
        let temp = new Uint8Array(this.buffer.length + incoming.length);
        temp.set(this.buffer, 0);
        temp.set(incoming, this.buffer.length);
        this.buffer = temp;

        while (this.buffer.length >= 28) {
            // Trama de telemetría de 28 bytes agregada de la serie de vibración WTVB
            if (this.buffer[0] === 0x55 && this.buffer[1] === 0x61) {
                const frame = this.buffer.slice(0, 28);
                this.decodeFrame(frame);
                this.buffer = this.buffer.slice(28);
            } else {
                this.buffer = this.buffer.slice(1);
            }
        }
    }

    combine(low, high) { return (high << 8) | low; }
    combineSigned(low, high) {
        let val = (high << 8) | low;
        return val >= 32768 ? val - 65536 : val;
    }

    decodeFrame(p) {
        const data = {
            timestamp: new Date().toLocaleTimeString(),
            vel: {
                x: this.combine(p[2], p[3]),
                y: this.combine(p[4], p[5]),
                z: this.combine(p[6], p[7])
            },
            angle: {
                x: Number((this.combineSigned(p[8], p[9]) / 32768.0 * 180.0).toFixed(2)),
                y: Number((this.combineSigned(p[10], p[11]) / 32768.0 * 180.0).toFixed(2)),
                z: Number((this.combineSigned(p[12], p[13]) / 32768.0 * 180.0).toFixed(2))
            },
            temp: Number((this.combineSigned(p[14], p[15]) / 100.0).toFixed(1)),
            disp: {
                x: this.combine(p[16], p[17]),
                y: this.combine(p[18], p[19]),
                z: this.combine(p[20], p[21])
            },
            freq: {
                x: this.combine(p[22], p[23]),
                y: this.combine(p[24], p[25]),
                z: this.combine(p[26], p[27])
            },
            battery: 100 // Estándar nominal para tramas exclusivas 0x61
        };

        if (this.onDataReceived) this.onDataReceived(data);
    }
}