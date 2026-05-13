import { WitMotionBLE } from './SensorBLE.js';
import { ChartManager } from './ChartManager.js';

// Cabecera unificada y completa para los reportes de telemetría
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

    // Reiniciar búfer dejando intacta la cabecera completa
    dataLog = ["Timestamp,VelX,VelY,VelZ,AngleX,AngleY,AngleZ,Temp,DispX,DispY,DispZ,FreqX,FreqY,FreqZ"];
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
        // Trama oficial para desbloqueo de registros: 0xFF 0xAA 0x69 0x88 0xB5
        await sensor.sendCommand([0xFF, 0xAA, 0x69, 0x88, 0xB5]);
        alert("Comando de desbloqueo transmitido exitosamente.");
    } catch (e) { alert("Fallo al escribir en la característica BLE."); }
});

document.getElementById('btnSaveConfig')?.addEventListener('click', async () => {
    if (!isConnected) return alert("Debes conectar el sensor primero.");
    try {
        // Guardado permanente (Save): 0xFF 0xAA 0x00 0x00 0x00
        await sensor.sendCommand([0xFF, 0xAA, 0x00, 0x00, 0x00]);
        alert("Configuración almacenada en la memoria no volátil del sensor.");
    } catch (e) { alert("Fallo al escribir en la característica BLE."); }
});

document.getElementById('btnCalibrateAngle')?.addEventListener('click', async () => {
    if (!isConnected) return alert("Debes conectar el sensor primero.");
    try {
        // Calibración de aceleración/sesgo: 0xFF 0xAA 0x01 0x01 0x00
        await sensor.sendCommand([0xFF, 0xAA, 0x01, 0x01, 0x00]);
        alert("Calibración enviada. Por favor, mantén el dispositivo en reposo absoluto.");
    } catch (e) { alert("Fallo al escribir en la característica BLE."); }
});

document.getElementById('btnResetZ')?.addEventListener('click', async () => {
    if (!isConnected) return alert("Debes conectar el sensor primero.");
    try {
        // Reset de la orientación del eje Z: 0xFF 0xAA 0x52 0x00 0x00
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
        // Obtenemos los ángulos limpios en punto flotante
        const pitch = parseFloat(d.angle.x) || 0;
        const roll  = parseFloat(d.angle.y) || 0;
        const yaw   = parseFloat(d.angle.z) || 0;

        // Actualizamos las tarjetas inferiores con sus símbolos
        document.getElementById('lblPitch').innerText = pitch.toFixed(2) + '°';
        document.getElementById('lblRoll').innerText  = roll.toFixed(2)  + '°';
        document.getElementById('lblYaw').innerText   = yaw.toFixed(2)   + '°';

        // Orden de Roto-traslación Espacial Corregida:
        // 1. rotateZ maneja la orientación de brújula plana sobre la mesa (Yaw)
        // 2. rotateX maneja el cabeceo frontal/trasero (Pitch)
        // 3. rotateY maneja el alabeo de lado a lado (Roll)
        cube.style.transform = `rotateZ(${yaw}deg) rotateX(${pitch}deg) rotateY(${roll}deg)`;
    }

    // 1. Actualizar datos del Osciloscopio (empujar nuevos valores y sacar viejos)
    oscDataX.push(d.vel.x); oscDataX.shift();
    oscDataY.push(d.vel.y); oscDataY.shift();
    oscDataZ.push(d.vel.z); oscDataZ.shift();
    drawOscilloscope(); // Redibujar onda en vivo

    // 2. Actualizar gráfico de tendencia RMS con el valor calculado
    summaryChart.data.datasets[0].data.push(parseFloat(vRms));
    summaryChart.data.datasets[0].data.shift();
    summaryChart.update();

    // --- ACTUALIZACIÓN DE INTERFAZ DE GRÁFICOS (KPIs y LEYENDAS) ---
    // 1. Valores instantáneos en las leyendas superiores
    const chkX = document.getElementById('chkValX');
    if (chkX) {
        chkX.innerText = d.angle.x + '°';
        document.getElementById('chkValY').innerText = d.angle.y + '°';
        document.getElementById('chkValZ').innerText = d.angle.z + '°';

        document.getElementById('chkVx').innerText = d.vel.x + ' mm/s';
        document.getElementById('chkVy').innerText = d.vel.y + ' mm/s';
        document.getElementById('chkVz').innerText = d.vel.z + ' mm/s';
    }

    // 2. Cálculo y retención de Picos Máximos (Ángulos)
    const absAx = Math.abs(parseFloat(d.angle.x) || 0);
    const absAy = Math.abs(parseFloat(d.angle.y) || 0);
    const absAz = Math.abs(parseFloat(d.angle.z) || 0);
    
    if (absAx > maxPeakAx) { maxPeakAx = absAx; document.getElementById('peakAx').innerText = maxPeakAx.toFixed(2) + '°'; }
    if (absAy > maxPeakAy) { maxPeakAy = absAy; document.getElementById('peakAy').innerText = maxPeakAy.toFixed(2) + '°'; }
    if (absAz > maxPeakAz) { maxPeakAz = absAz; document.getElementById('peakAz').innerText = maxPeakAz.toFixed(2) + '°'; }

    // 3. Retención de Pico Máximo (Velocidad)
    const currentMaxVel = Math.max(Math.abs(d.vel.x), Math.abs(d.vel.y), Math.abs(d.vel.z));
    if (currentMaxVel > maxPeakVel) {
        maxPeakVel = currentMaxVel;
        document.getElementById('peakVel').innerText = maxPeakVel + ' mm/s';
    }

    // 4. Inteligencia de Diagnóstico: Evaluación Normativa ISO 10816 (Ventana Móvil)
    // Obtenemos el vector de velocidad combinada instantánea
    const currentInstVel = Math.sqrt(d.vel.x**2 + d.vel.y**2 + d.vel.z**2);
    
    // Alimentamos la ventana móvil y limitamos su tamaño al del gráfico (50 puntos)
    rollingVelHistory.push(currentInstVel);
    if (rollingVelHistory.length > 50) {
        rollingVelHistory.shift();
    }

    // Calculamos el valor RMS real sobre el historial reciente visible
    const sumOfSquares = rollingVelHistory.reduce((sum, v) => sum + (v ** 2), 0);
    const windowRms = Math.sqrt(sumOfSquares / rollingVelHistory.length);

    const isoElem = document.getElementById('isoStatus');
    if (isoElem) {
        // Evaluamos la severidad basándonos en la tendencia energética de la ventana
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
}

function drawOscilloscope() {
    const canvas = document.getElementById('oscilloscopeCanvas');
    const parent = canvas.parentElement;
    
    // Evitar bucle de redimensionamiento redibujando solo si cambió el contenedor
    if (canvas.width !== parent.clientWidth || canvas.height !== parent.clientHeight) {
        canvas.width = parent.clientWidth;
        canvas.height = parent.clientHeight;
    }
    
    const width = canvas.width;
    const height = canvas.height;
    const midY = height / 2;
    
    // Limpiar fondo
    oscCtx.clearRect(0, 0, width, height);
    
    // Dibujar rejilla de fondo estilo osciloscopio
    oscCtx.strokeStyle = '#27272a';
    oscCtx.lineWidth = 1;
    oscCtx.beginPath();
    for (let i = 0; i < width; i += 40) { oscCtx.moveTo(i, 0); oscCtx.lineTo(i, height); }
    for (let j = 0; j < height; j += 30) { oscCtx.moveTo(0, j); oscCtx.lineTo(width, j); }
    oscCtx.stroke();
    
    // Línea central (Nivel Cero)
    oscCtx.strokeStyle = '#3f3f46';
    oscCtx.beginPath();
    oscCtx.moveTo(0, midY);
    oscCtx.lineTo(width, midY);
    oscCtx.stroke();

    // --- NUEVO: ALGORITMO DE AUTO-ESCALADO DINÁMICO ---
    // 1. Encontrar el valor absoluto más alto entre los tres ejes actuales
    let maxPeak = 0;
    for (let i = 0; i < oscDataX.length; i++) {
        const peakX = Math.abs(oscDataX[i]);
        const peakY = Math.abs(oscDataY[i]);
        const peakZ = Math.abs(oscDataZ[i]);
        maxPeak = Math.max(maxPeak, peakX, peakY, peakZ);
    }
    
    // 2. Definir un rango mínimo para que la onda no tiemble si el sensor está en reposo absoluto
    // Si el pico es menor a 20 mm/s, usamos 20 como techo. Si es mayor, le damos un 15% de margen superior.
    const currentScaleMax = Math.max(20, maxPeak * 1.15);

    // Función interna para trazar una onda adaptada a la nueva escala
    const plotWave = (dataArray, color) => {
        oscCtx.strokeStyle = color;
        oscCtx.lineWidth = 2;
        oscCtx.beginPath();
        const step = width / (dataArray.length - 1);
        
        for (let i = 0; i < dataArray.length; i++) {
            const x = i * step;
            // Mapeo proporcional: (valor / rango_maximo) * mitad_de_altura
            const y = midY - (dataArray[i] / currentScaleMax) * (midY - 5); // 5px de padding extra
            
            if (i === 0) oscCtx.moveTo(x, y);
            else oscCtx.lineTo(x, y);
        }
        oscCtx.stroke();
    };

    // Dibujar las tres señales
    plotWave(oscDataX, '#3282f6'); // Azul para Eje X
    plotWave(oscDataY, '#eab308'); // Amarillo para Eje Y
    plotWave(oscDataZ, '#10b981'); // Verde para Eje Z

// --- TEXTOS Y LEYENDA EN LA ESQUINA SUPERIOR ---
    // 1. Indicador de Escala actual
    oscCtx.fillStyle = '#6b7280';
    oscCtx.font = '11px system-ui, sans-serif';
    oscCtx.fillText(`Escala: ±${Math.round(currentScaleMax)} mm/s`, 15, 22);

    // 2. Leyenda de Ejes (X, Y, Z)
    const legendX = 140; // Posición horizontal donde empieza la leyenda
    
    // Eje X (Azul)
    oscCtx.fillStyle = '#3282f6';
    oscCtx.fillRect(legendX, 13, 10, 10);
    oscCtx.fillStyle = '#a1a1aa';
    oscCtx.fillText('Vel X', legendX + 15, 22);

    // Eje Y (Amarillo)
    oscCtx.fillStyle = '#eab308';
    oscCtx.fillRect(legendX + 60, 13, 10, 10);
    oscCtx.fillStyle = '#a1a1aa';
    oscCtx.fillText('Vel Y', legendX + 75, 22);

    // Eje Z (Verde)
    oscCtx.fillStyle = '#10b981';
    oscCtx.fillRect(legendX + 120, 13, 10, 10);
    oscCtx.fillStyle = '#a1a1aa';
    oscCtx.fillText('Vel Z', legendX + 135, 22);
} 

// Gráfico de Resumen de Tendencia RMS (usando Chart.js ya importado)
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
// Redimensionar canvas nativo en cambios de ventana
window.addEventListener('resize', drawOscilloscope);

// --- SISTEMA DE CÁMARA INTERACTIVA 3D (ORBITAR Y ZOOM) ---
const sceneContainer = document.getElementById('sceneContainer');
const viewWrapper    = document.querySelector('.view-3d-wrapper');
const btnResetCam    = document.getElementById('btnResetCam');

// Variables de estado inicial de la cámara isométrica
let camRotX = -25; 
let camRotY = -20;
let camZoom = 1;

let isDragging = false;
let startX = 0;
let startY = 0;

function updateCamera() {
    if (!sceneContainer) return;
    // Aplicamos la escala (zoom) y las rotaciones globales al escenario padre
    sceneContainer.style.transform = `scale(${camZoom}) rotateX(${camRotX}deg) rotateY(${camRotY}deg)`;
}

if (viewWrapper && sceneContainer) {
    // 1. Iniciar arrastre
    viewWrapper.addEventListener('mousedown', (e) => {
        // Ignorar clics sobre los botones o tarjetas para no interferir
        if (e.target.closest('.camera-controls') || e.target.closest('.attitude-panels')) return;
        
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        sceneContainer.classList.remove('smooth-cam'); // Desactivar animación para respuesta instantánea
    });

    // 2. Mover ratón (Orbitar)
    window.addEventListener('mousemove', (e) => {
        if (!isDragging) return;

        const deltaX = e.clientX - startX;
        const deltaY = e.clientY - startY;

        // Ajustar sensibilidad de giro (0.5 grados por píxel recorrido)
        camRotY += deltaX * 0.5;
        camRotX -= deltaY * 0.5; // Invertido para que el cabeceo sea natural al arrastrar

        // Limitar el cabeceo vertical para que el escenario no quede totalmente de cabeza
        camRotX = Math.max(-85, Math.min(85, camRotX));

        updateCamera();

        startX = e.clientX;
        startY = e.clientY;
    });

    // 3. Soltar clic
    window.addEventListener('mouseup', () => {
        isDragging = false;
    });

    // 4. Rueda del ratón (Zoom)
    viewWrapper.addEventListener('wheel', (e) => {
        e.preventDefault(); // Evita hacer scroll en la página principal
        
        // Modificar zoom basado en la dirección de la rueda
        camZoom += e.deltaY * -0.0015;
        // Limitar escala de alejamiento y acercamiento (entre 0.6x y 2.2x)
        camZoom = Math.max(0.6, Math.min(2.2, camZoom)); 

        sceneContainer.classList.remove('smooth-cam');
        updateCamera();
    });

    // 5. Botón de Restablecimiento
    if (btnResetCam) {
        btnResetCam.addEventListener('click', () => {
            camRotX = -25;
            camRotY = -20;
            camZoom = 1;
            
            // Añadir clase para que el retorno sea animado y suave
            sceneContainer.classList.add('smooth-cam');
            updateCamera();
        });
    }
}