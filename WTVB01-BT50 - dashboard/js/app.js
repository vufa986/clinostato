import { WitMotionBLE } from './SensorBLE.js';
import { ChartManager } from './ChartManager.js';

// Cabecera unificada y completa para los reportes de telemetría (17 Columnas)
const CSV_HEADER = "Timestamp,VelX,VelY,VelZ,VelRMS,AngleX,AngleY,AngleZ,Temp,DispX,DispY,DispZ,DispRMS,FreqX,FreqY,FreqZ,Battery";

const colors = { x: '#3282f6', y: '#eab308', z: '#10b981' };
const angleChart = new ChartManager('angleChart', colors);
const velChart   = new ChartManager('velChart', colors);

// --- NUEVOS GESTORES PARA EL OSCILOSCOPIO Y RESUMEN EN LA VISTA PRINCIPAL ---
const oscCtx = document.getElementById('oscilloscopeCanvas').getContext('2d');
const sumCtx = document.getElementById('summaryChartCanvas').getContext('2d');

let sensor = null;

// Búfer para calcular el historial de severidad en ventana móvil (50 puntos)
let rollingVelHistory = [];

// Memoria de picos máximos para los gráficos
let maxPeakAx = 0, maxPeakAy = 0, maxPeakAz = 0;
let maxPeakVel = 0;

let lastUpdate = 0;
let dataLog = []; 
let isLogging = false;
let isConnected = false;

// Configuración del Osciloscopio nativo (Barrido en Canvas)
let oscDataX = new Array(100).fill(0);
let oscDataY = new Array(100).fill(0);
let oscDataZ = new Array(100).fill(0);

let batchInterval = null;
const BATCH_TIME_MS = 60 * 60 * 1000; // 1 Hora

const btnConnect   = document.getElementById('btnConectar');
const btnExport    = document.getElementById('btnExportar');
const btnToggleLog = document.getElementById('btnToggleLog');
const deviceName   = document.getElementById('deviceName');
const logBadge     = document.getElementById('logBadge');
const recordCount  = document.getElementById('recordCount');

// --- GESTIÓN DEL ESTADO DE GRABACIÓN ---
function actualizarEstadoGrabacion(activa) {
    isLogging = activa;
    if (isLogging) {
        logBadge.innerText = "🔴 Grabación Activa";
        logBadge.className = "badge log-active";
        btnToggleLog.innerText = "Pausar Grabación";
        btnToggleLog.classList.add('active');
    } else {
        logBadge.innerText = "⏹️ Grabación en Pausa";
        logBadge.className = "badge log-inactive";
        btnToggleLog.innerText = "🔴 Reanudar Grabación";
        btnToggleLog.classList.remove('active');
    }
}

function descargarLoteCSV(esCierreManual = false) {
    if (dataLog.length <= 1) return;

    const csvContent = "data:text/csv;charset=utf-8," + dataLog.join("\n");
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    
    const fecha = new Date();
    const timestampStr = fecha.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const sufijo = esCierreManual ? "_manual" : "_lote_1h";
    
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `telemetria_wtvb01_${timestampStr}${sufijo}.csv`);
    
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    // CORRECCIÓN: Reiniciar búfer utilizando la cabecera completa oficial
    dataLog = [CSV_HEADER];
    recordCount.innerText = "0";
    console.log(`Lote CSV guardado en disco y RAM liberada a las ${fecha.toLocaleTimeString()}`);
}

sensor = new WitMotionBLE(
    (data) => {
        renderUI(data);
        
        const now = Date.now();
        if (now - lastUpdate > 100) {
            angleChart.update(data.angle.x, data.angle.y, data.angle.z);
            velChart.update(data.vel.x, data.vel.y, data.vel.z);
            lastUpdate = now;
        }

        if (isLogging) {
            // Calculamos los valores globales combinados para que queden plasmados en el reporte
            const vRms = Math.sqrt(data.vel.x**2 + data.vel.y**2 + data.vel.z**2).toFixed(1);
            const dRms = Math.sqrt(data.disp.x**2 + data.disp.y**2 + data.disp.z**2).toFixed(0);
            const battery = data.battery || 100;

            // Almacenamos la trama de 17 columnas perfectamente alineada con el CSV_HEADER
            dataLog.push(
                `${data.timestamp},${data.vel.x},${data.vel.y},${data.vel.z},${vRms},` +
                `${data.angle.x},${data.angle.y},${data.angle.z},${data.temp},` +
                `${data.disp.x},${data.disp.y},${data.disp.z},${dRms},` +
                `${data.freq.x},${data.freq.y},${data.freq.z},${battery}`
            );
            
            recordCount.innerText = dataLog.length - 1;
        }
    },
    () => {
        isConnected = false;
        deviceName.innerText = "Sensor Desconectado";
        btnConnect.innerText = "Conectar";
        btnConnect.disabled  = false;
        
        if (batchInterval) clearInterval(batchInterval);
        if (dataLog.length > 1) descargarLoteCSV(true);
        
        actualizarEstadoGrabacion(false);
        btnExport.disabled = true;
        btnToggleLog.disabled = true;
    }
);

btnConnect.addEventListener('click', async () => {
    try {
        btnConnect.disabled = true;
        btnConnect.innerText = "Conectando...";
        const name = await sensor.connect();
        
        isConnected = true;
        deviceName.innerText = name;
        btnConnect.innerText = "Conectado";
        
        dataLog = [CSV_HEADER];
        btnExport.disabled = false;
        btnToggleLog.disabled = false;
        
        actualizarEstadoGrabacion(true);

        if (batchInterval) clearInterval(batchInterval);
        batchInterval = setInterval(() => {
            descargarLoteCSV(false);
        }, BATCH_TIME_MS);

    } catch (e) {
        alert("Error al inicializar Bluetooth: " + e.message);
        btnConnect.disabled = false;
        btnConnect.innerText = "Conectar";
    }
});

btnToggleLog.addEventListener('click', () => {
    actualizarEstadoGrabacion(!isLogging);
});

btnExport.addEventListener('click', () => {
    descargarLoteCSV(true);
});

// --- ENLACE DE COMANDOS DE HARDWARE WITMOTION ---
document.getElementById('btnUnlock')?.addEventListener('click', async () => {
    if (!isConnected) return alert("Debes conectar el sensor primero.");
    try {
        await sensor.sendCommand([0xFF, 0xAA, 0x69, 0x88, 0xB5]);
        alert("Comando de desbloqueo transmitido exitosamente.");
    } catch (e) { alert("Fallo al escribir en la característica BLE."); }
});

document.getElementById('btnSaveConfig')?.addEventListener('click', async () => {
    if (!isConnected) return alert("Debes conectar el sensor primero.");
    try {
        await sensor.sendCommand([0xFF, 0xAA, 0x00, 0x00, 0x00]);
        alert("Configuración almacenada en la memoria no volátil del sensor.");
    } catch (e) { alert("Fallo al escribir en la característica BLE."); }
});

document.getElementById('btnCalibrateAngle')?.addEventListener('click', async () => {
    if (!isConnected) return alert("Debes conectar el sensor primero.");
    try {
        await sensor.sendCommand([0xFF, 0xAA, 0x01, 0x01, 0x00]);
        alert("Calibración enviada. Por favor, mantén el dispositivo en reposo absoluto.");
    } catch (e) { alert("Fallo al escribir en la característica BLE."); }
});

document.getElementById('btnResetZ')?.addEventListener('click', async () => {
    if (!isConnected) return alert("Debes conectar el sensor primero.");
    try {
        await sensor.sendCommand([0xFF, 0xAA, 0x52, 0x00, 0x00]);
        alert("Eje Z referenciado a 0°.");
    } catch (e) { alert("Fallo al escribir en la característica BLE."); }
});

window.switchTab = function(tabId, element) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.nav-tab').forEach(el => el.classList.remove('active'));
    document.getElementById('tab-' + tabId).classList.add('active');
    element.classList.add('active');
};

function renderUI(d) {
    // Nodos simples
    document.getElementById('ax').innerText = d.angle.x; 
    document.getElementById('ay').innerText = d.angle.y; 
    document.getElementById('az').innerText = d.angle.z;
    
    document.getElementById('vx').innerText = d.vel.x;   
    document.getElementById('vy').innerText = d.vel.y;   
    document.getElementById('vz').innerText = d.vel.z;
    
    // Nodos calculados: Velocidad Global Combinada (Raíz Cuadrada Media)
    const vRms = Math.sqrt(d.vel.x**2 + d.vel.y**2 + d.vel.z**2).toFixed(1);
    document.getElementById('vTotal').innerText = vRms;

    document.getElementById('dx').innerText = d.disp.x;  
    document.getElementById('dy').innerText = d.disp.y;  
    document.getElementById('dz').innerText = d.disp.z;
    
    // Nodos calculados: Desplazamiento Global Combinado
    const dRms = Math.sqrt(d.disp.x**2 + d.disp.y**2 + d.disp.z**2).toFixed(0);
    document.getElementById('dTotal').innerText = dRms;

    document.getElementById('fx').innerText = d.freq.x;  
    document.getElementById('fy').innerText = d.freq.y;  
    document.getElementById('fz').innerText = d.freq.z;
    
    document.getElementById('temp').innerText = d.temp;
    if (d.battery) document.getElementById('batteryVal').innerText = d.battery;

    // --- ACTUALIZACIÓN DINÁMICA DEL MODELO 3D (PRISMA SÓLIDO) ---
    const cube = document.getElementById('sensorCube');
    if (cube) {
        const pitch = parseFloat(d.angle.x) || 0;
        const roll  = parseFloat(d.angle.y) || 0;
        const yaw   = parseFloat(d.angle.z) || 0;

        document.getElementById('lblPitch').innerText = pitch.toFixed(2) + '°';
        document.getElementById('lblRoll').innerText  = roll.toFixed(2)  + '°';
        document.getElementById('lblYaw').innerText   = yaw.toFixed(2)   + '°';

        cube.style.transform = `rotateZ(${yaw}deg) rotateX(${pitch}deg) rotateY(${roll}deg)`;
    }

    // 1. Actualizar datos del Osciloscopio
    oscDataX.push(d.vel.x); oscDataX.shift();
    oscDataY.push(d.vel.y); oscDataY.shift();
    oscDataZ.push(d.vel.z); oscDataZ.shift();
    drawOscilloscope();

    // 2. Actualizar gráfico de tendencia RMS
    summaryChart.data.datasets[0].data.push(parseFloat(vRms));
    summaryChart.data.datasets[0].data.shift();
    summaryChart.update();

    // --- ACTUALIZACIÓN DE INTERFAZ DE GRÁFICOS (KPIs y LEYENDAS) ---
    const chkX = document.getElementById('chkValX');
    if (chkX) {
        chkX.innerText = d.angle.x + '°';
        document.getElementById('chkValY').innerText = d.angle.y + '°';
        document.getElementById('chkValZ').innerText = d.angle.z + '°';

        document.getElementById('chkVx').innerText = d.vel.x + ' mm/s';
        document.getElementById('chkVy').innerText = d.vel.y + ' mm/s';
        document.getElementById('chkVz').innerText = d.vel.z + ' mm/s';
    }

    const absAx = Math.abs(parseFloat(d.angle.x) || 0);
    const absAy = Math.abs(parseFloat(d.angle.y) || 0);
    const absAz = Math.abs(parseFloat(d.angle.z) || 0);
    
    if (absAx > maxPeakAx) { maxPeakAx = absAx; document.getElementById('peakAx').innerText = maxPeakAx.toFixed(2) + '°'; }
    if (absAy > maxPeakAy) { maxPeakAy = absAy; document.getElementById('peakAy').innerText = maxPeakAy.toFixed(2) + '°'; }
    if (absAz > maxPeakAz) { maxPeakAz = absAz; document.getElementById('peakAz').innerText = maxPeakAz.toFixed(2) + '°'; }

    const currentMaxVel = Math.max(Math.abs(d.vel.x), Math.abs(d.vel.y), Math.abs(d.vel.z));
    if (currentMaxVel > maxPeakVel) {
        maxPeakVel = currentMaxVel;
        document.getElementById('peakVel').innerText = maxPeakVel + ' mm/s';
    }

    // 4. Inteligencia de Diagnóstico: Evaluación Normativa ISO 10816
    const currentInstVel = Math.sqrt(d.vel.x**2 + d.vel.y**2 + d.vel.z**2);
    
    rollingVelHistory.push(currentInstVel);
    if (rollingVelHistory.length > 50) {
        rollingVelHistory.shift();
    }

    const sumOfSquares = rollingVelHistory.reduce((sum, v) => sum + (v ** 2), 0);
    const windowRms = Math.sqrt(sumOfSquares / rollingVelHistory.length);

    const isoElem = document.getElementById('isoStatus');
    if (isoElem) {
        if (windowRms < 1.8) {
            isoElem.innerHTML = "🟢 Óptimo";
            isoElem.className = "status-good";
        } else if (windowRms < 4.5) {
            isoElem.innerHTML = "🟡 Aceptable";
            isoElem.className = "status-warn";
        } else if (windowRms < 11.0) {
            isoElem.innerHTML = "🟠 Alerta";
            isoElem.className = "status-alert";
        } else {
            isoElem.innerHTML = "🔴 Peligro";
            isoElem.className = "status-danger";
        }
    }

    // --- PUENTE NO DESTRUCTIVO HACIA EL IFRAME ---
    const hudFrame = document.getElementById('hudFrame');
    if (hudFrame && hudFrame.contentWindow && isLogging) {
        hudFrame.contentWindow.postMessage({
            type: 'WITMOTION_TELEMETRY',
            payload: {
                timestamp: d.timestamp,
                pitch: d.angle.x,
                roll: d.angle.y,
                yaw: d.angle.z,
                freqZ: d.freq.z
            }
        }, '*');
    }
}

function drawOscilloscope() {
    const canvas = document.getElementById('oscilloscopeCanvas');
    const parent = canvas.parentElement;
    
    if (canvas.width !== parent.clientWidth || canvas.height !== parent.clientHeight) {
        canvas.width = parent.clientWidth;
        canvas.height = parent.clientHeight;
    }
    
    const width = canvas.width;
    const height = canvas.height;
    const midY = height / 2;
    
    oscCtx.clearRect(0, 0, width, height);
    
    oscCtx.strokeStyle = '#27272a';
    oscCtx.lineWidth = 1;
    oscCtx.beginPath();
    for (let i = 0; i < width; i += 40) { oscCtx.moveTo(i, 0); oscCtx.lineTo(i, height); }
    for (let j = 0; j < height; j += 30) { oscCtx.moveTo(0, j); oscCtx.lineTo(width, j); }
    oscCtx.stroke();
    
    oscCtx.strokeStyle = '#3f3f46';
    oscCtx.beginPath();
    oscCtx.moveTo(0, midY);
    oscCtx.lineTo(width, midY);
    oscCtx.stroke();

    let maxPeak = 0;
    for (let i = 0; i < oscDataX.length; i++) {
        const peakX = Math.abs(oscDataX[i]);
        const peakY = Math.abs(oscDataY[i]);
        const peakZ = Math.abs(oscDataZ[i]);
        maxPeak = Math.max(maxPeak, peakX, peakY, peakZ);
    }
    
    const currentScaleMax = Math.max(20, maxPeak * 1.15);

    const plotWave = (dataArray, color) => {
        oscCtx.strokeStyle = color;
        oscCtx.lineWidth = 2;
        oscCtx.beginPath();
        const step = width / (dataArray.length - 1);
        
        for (let i = 0; i < dataArray.length; i++) {
            const x = i * step;
            const y = midY - (dataArray[i] / currentScaleMax) * (midY - 5);
            
            if (i === 0) oscCtx.moveTo(x, y);
            else oscCtx.lineTo(x, y);
        }
        oscCtx.stroke();
    };

    plotWave(oscDataX, '#3282f6'); 
    plotWave(oscDataY, '#eab308'); 
    plotWave(oscDataZ, '#10b981'); 

    oscCtx.fillStyle = '#6b7280';
    oscCtx.font = '11px system-ui, sans-serif';
    oscCtx.fillText(`Escala: ±${Math.round(currentScaleMax)} mm/s`, 15, 22);

    const legendX = 140; 
    
    oscCtx.fillStyle = '#3282f6';
    oscCtx.fillRect(legendX, 13, 10, 10);
    oscCtx.fillStyle = '#a1a1aa';
    oscCtx.fillText('Vel X', legendX + 15, 22);

    oscCtx.fillStyle = '#eab308';
    oscCtx.fillRect(legendX + 60, 13, 10, 10);
    oscCtx.fillStyle = '#a1a1aa';
    oscCtx.fillText('Vel Y', legendX + 75, 22);

    oscCtx.fillStyle = '#10b981';
    oscCtx.fillRect(legendX + 120, 13, 10, 10);
    oscCtx.fillStyle = '#a1a1aa';
    oscCtx.fillText('Vel Z', legendX + 135, 22);
} 

const summaryChart = new Chart(sumCtx, {
    type: 'line',
    data: {
        labels: Array(20).fill(''),
        datasets: [{
            label: 'RMS Total (mm/s)',
            borderColor: '#ef4444',
            backgroundColor: 'rgba(239, 68, 68, 0.1)',
            fill: true,
            data: Array(20).fill(0),
            tension: 0.3,
            borderWidth: 2,
            pointRadius: 0
        }]
    },
    options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { display: false } },
        scales: { 
            x: { display: false }, 
            y: { grid: { color: '#27272a' }, ticks: { color: '#a1a1aa', font: { size: 10 } } } 
        }
    }
});

window.addEventListener('resize', drawOscilloscope);

// --- SISTEMA DE CÁMARA INTERACTIVA 3D (ORBITAR Y ZOOM) ---
const sceneContainer = document.getElementById('sceneContainer');
const viewWrapper    = document.querySelector('.view-3d-wrapper');
const btnResetCam    = document.getElementById('btnResetCam');

let camRotX = -25; 
let camRotY = -20;
let camZoom = 1;

let isDragging = false;
let startX = 0;
let startY = 0;

function updateCamera() {
    if (!sceneContainer) return;
    sceneContainer.style.transform = `scale(${camZoom}) rotateX(${camRotX}deg) rotateY(${camRotY}deg)`;
}

if (viewWrapper && sceneContainer) {
    viewWrapper.addEventListener('mousedown', (e) => {
        if (e.target.closest('.camera-controls') || e.target.closest('.attitude-panels')) return;
        
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        sceneContainer.classList.remove('smooth-cam'); 
    });

    window.addEventListener('mousemove', (e) => {
        if (!isDragging) return;

        const deltaX = e.clientX - startX;
        const deltaY = e.clientY - startY;

        camRotY += deltaX * 0.5;
        camRotX -= deltaY * 0.5; 

        camRotX = Math.max(-85, Math.min(85, camRotX));

        updateCamera();

        startX = e.clientX;
        startY = e.clientY;
    });

    window.addEventListener('mouseup', () => {
        isDragging = false;
    });

    viewWrapper.addEventListener('wheel', (e) => {
        e.preventDefault(); 
        
        camZoom += e.deltaY * -0.0015;
        camZoom = Math.max(0.6, Math.min(2.2, camZoom)); 

        sceneContainer.classList.remove('smooth-cam');
        updateCamera();
    });

    if (btnResetCam) {
        btnResetCam.addEventListener('click', () => {
            camRotX = -25;
            camRotY = -20;
            camZoom = 1;
            
            sceneContainer.classList.add('smooth-cam');
            updateCamera();
        });
    }
}