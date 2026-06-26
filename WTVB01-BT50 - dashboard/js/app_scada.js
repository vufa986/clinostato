import { ChartManager } from './ChartManager.js';

// ==================== CONFIGURACIÓN GLOBAL ====================
const CONFIG = {
    COLORS: { x: '#3282f6', y: '#eab308', z: '#10b981' },
    MAX_TRAJ_POINTS: 150,
    UPDATE_INTERVAL: 100,
    PLOTLY_UPDATE_THROTTLE: 100,
    OSC_SAMPLES: 100,
    SUMMARY_SAMPLES: 20,
    SPHERE_RADIUS: 1.2,
    SENSOR_SIZE: { w: 0.4, l: 0.6, h: 0.15 },
    MIN_G_VALUE: 0.000001 // Umbral extremadamente bajo para que siempre se agreguen puntos
};

// ==================== UTILIDADES ====================
const updateText = (id, val, suffix = '') => {
    const el = document.getElementById(id);
    if (el) el.innerText = suffix ? `${val}${suffix}` : val;
};

const formatDegrees = (val) => val.toFixed(2) + '°';
const formatGForce = (val) => val.toFixed(5) + ' G';

// ==================== GESTOR DE TABS ====================
window.switchTab = function(tabId, element) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.nav-tab').forEach(el => el.classList.remove('active'));
    document.getElementById('tab-' + tabId).classList.add('active');
    element.classList.add('active');
    
    const resizeMap = {
        '3d': 'plotlySensor',
        'tasmg': ['plotlySphere', 'plotly2D']
    };
    
    if (resizeMap[tabId]) {
        const targets = Array.isArray(resizeMap[tabId]) ? resizeMap[tabId] : [resizeMap[tabId]];
        targets.forEach(id => {
            if (document.getElementById(id) && typeof Plotly !== 'undefined') {
                Plotly.Plots.resize(id);
            }
        });
    }
};

// ==================== INTERACCIÓN 3D ====================
let isInteracting3D = false;

function setupInteractionLock(elementId) {
    const el = document.getElementById(elementId);
    if (!el) return;
    el.addEventListener('mousedown', () => isInteracting3D = true);
    el.addEventListener('touchstart', () => isInteracting3D = true, { passive: true });
}

window.addEventListener('mouseup', () => isInteracting3D = false);
window.addEventListener('touchend', () => isInteracting3D = false);

// ==================== RENDERIZADO DE ESFERA TASMG ====================
class SphereRenderer {
    constructor() {
        this.trajX = []; this.trajY = []; this.trajZ = [];
        this.isPlotly2DInitialized = false;
        this.MAX_POINTS = 150; 
        this.initSphereMesh();
        this.initPlotly();
        // Semilla para que el buffer nunca esté vacío
        this.trajX.push(0); this.trajY.push(0); this.trajZ.push(-1);
    }

    initSphereMesh() {
        const u = Array.from({ length: 21 }, (_, i) => i * Math.PI / 10);
        const v = Array.from({ length: 21 }, (_, i) => i * Math.PI / 20);
        const x_sph = [], y_sph = [], z_sph = [];
        for (let i = 0; i < u.length; i++) {
            const xr = [], yr = [], zr = [];
            for (let j = 0; j < v.length; j++) {
                xr.push(Math.cos(u[i]) * Math.sin(v[j]));
                yr.push(Math.sin(u[i]) * Math.sin(v[j]));
                zr.push(Math.cos(v[j]));
            }
            x_sph.push(xr); y_sph.push(yr); z_sph.push(zr);
        }
        
        this.sphereTrace = {
            type: 'surface', x: x_sph, y: y_sph, z: z_sph,
            opacity: 0.1, colorscale: [[0, '#1e1e1e'], [1, '#3282f6']], showscale: false,
            contours: { x: { show: true, color: '#3282f6', width: 1 }, y: { show: true, color: '#3282f6', width: 1 }, z: { show: true, color: '#3282f6', width: 1 } },
            hoverinfo: 'skip'
        };
        
        this.trajectoryTrace = {
            type: 'scatter3d', mode: 'lines',
            x: [], y: [], z: [],
            line: { color: '#eab308', width: 3 },
            name: 'Estela G',
            hoverinfo: 'skip' // <- Oculta los molestos tooltips
        };
        
        this.currentGTrace = {
            type: 'scatter3d', mode: 'markers', x: [0], y: [0], z: [-1],
            marker: { size: 6, color: '#00ff95', symbol: 'diamond' },
            name: 'G Actual',
            hoverinfo: 'skip' // <- Oculta los molestos tooltips
        };
    }
    
    initPlotly() {
        const layout = {
            uirevision: true, margin: { l: 0, r: 0, b: 0, t: 0 }, paper_bgcolor: 'transparent',
            scene: {
                xaxis: { title: '', range: [-1.2, 1.2], showgrid: false, zerolinecolor: '#ef4444', zerolinewidth: 2, showticklabels: false, showbackground: false },
                yaxis: { title: '', range: [-1.2, 1.2], showgrid: false, zerolinecolor: '#10b981', zerolinewidth: 2, showticklabels: false, showbackground: false },
                zaxis: { title: '', range: [-1.2, 1.2], showgrid: false, zerolinecolor: '#3282f6', zerolinewidth: 2, showticklabels: false, showbackground: false },
                camera: { eye: { x: 1.5, y: 1.5, z: 1.5 } }
            },
            showlegend: false
        };
        if (document.getElementById('plotlySphere') && typeof Plotly !== 'undefined') {
            Plotly.newPlot('plotlySphere', [this.sphereTrace, this.trajectoryTrace, this.currentGTrace], layout, { responsive: true });
        }
    }

    updateTrajectory(gx, gy, gz) {
        if (this.trajX.length > 0) {
            const lastX = this.trajX[this.trajX.length - 1];
            const lastY = this.trajY[this.trajY.length - 1];
            const lastZ = this.trajZ[this.trajZ.length - 1];
            const delta = Math.sqrt(Math.pow(gx - lastX, 2) + Math.pow(gy - lastY, 2) + Math.pow(gz - lastZ, 2));
            if (delta < CONFIG.MIN_G_VALUE) return; 
        }
        this.trajX.push(gx); this.trajY.push(gy); this.trajZ.push(gz);
        if (this.trajX.length > this.MAX_POINTS) {
            this.trajX.shift(); this.trajY.shift(); this.trajZ.shift();
        }
    }

    updatePlotly(gx, gy, gz) {
        if (!document.getElementById('tab-tasmg')?.classList.contains('active') || typeof Plotly === 'undefined') return;

        // Escudo anti-lag: No inyecta datos al 3D si lo estás rotando con el ratón
        if (!isInteracting3D) {
            Plotly.restyle('plotlySphere', {
                x: [[...this.trajX, gx], [gx]],
                y: [[...this.trajY, gy], [gy]],
                z: [[...this.trajZ, gz], [gz]]
            }, [1, 2]); 
        }

        this.update2DMap(gx, gy);
    }

    update2DMap(gx, gy) {
        const p2D = document.getElementById('plotly2D');
        // Protección 1: No hacer nada si la pestaña está oculta
        if (!p2D || p2D.clientWidth <= 0) return;

        if (!this.isPlotly2DInitialized) {
            const layout = {
                uirevision: 'true', margin: { l: 25, r: 25, b: 25, t: 25 }, paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
                xaxis: { title: '', range: [-1.2, 1.2], fixedrange: true, constrain: 'domain', gridcolor: '#27272a', zerolinecolor: '#ef4444', zerolinewidth: 2, tickfont: { color: '#61616a', size: 10 } },
                yaxis: { title: '', range: [-1.2, 1.2], fixedrange: true, constrain: 'domain', gridcolor: '#27272a', zerolinecolor: '#10b981', zerolinewidth: 2, tickfont: { color: '#61616a', size: 10 }, scaleanchor: 'x', scaleratio: 1 },
                showlegend: false,
                shapes: [
                    { type: 'circle', xref: 'x', yref: 'y', x0: -1, y0: -1, x1: 1, y1: 1, line: { color: '#3282f6', width: 2, dash: 'dot' } },
                    { type: 'circle', xref: 'x', yref: 'y', x0: -0.5, y0: -0.5, x1: 0.5, y1: 0.5, line: { color: '#3f3f46', width: 1, dash: 'dot' } }
                ]
            };
            const traceTrail = { type: 'scatter', mode: 'lines', x: [], y: [], line: { color: 'rgba(234, 179, 8, 0.8)', width: 2 }, hoverinfo: 'skip' };
            const traceVector = { type: 'scatter', mode: 'lines', x: [0, gx], y: [0, gy], line: { color: '#00ff95', width: 2 }, hoverinfo: 'skip' };
            const traceDot = { type: 'scatter', mode: 'markers', x: [gx], y: [gy], marker: { size: 10, color: '#00ff95', symbol: 'cross' }, hoverinfo: 'skip' };

            Plotly.newPlot(p2D, [traceTrail, traceVector, traceDot], layout, { responsive: true, displayModeBar: false });
            this.isPlotly2DInitialized = true;
            
        } else if (p2D.data) {
            // Protección 2: Solo actualiza si Plotly ya terminó de armar el objeto interno
            Plotly.restyle(p2D, {
                x: [[...this.trajX, gx], [0, gx], [gx]],
                y: [[...this.trajY, gy], [0, gy], [gy]]
            }, [0, 1, 2]);
        }
    }

    init2DMap(container, gx, gy) {
        this.update2DMap(gx, gy);
    }

    resetTrajectory() {
        this.trajX = []; this.trajY = []; this.trajZ = [];
        this.isPlotly2DInitialized = false;
    }
}

// ==================== RENDERIZADO DE SENSOR 3D ====================
class Sensor3DRenderer {
    constructor() {
        this.initGeometry();
        this.initPlotly();
    }
    
    initGeometry() {
        const { w, l, h } = CONFIG.SENSOR_SIZE;
        this.vertices = [
            [ w,  l, -h], [-w,  l, -h], [-w, -l, -h], [ w, -l, -h],
            [ w,  l,  h], [-w,  l,  h], [-w, -l,  h], [ w, -l,  h]
        ];
        
        this.meshIndices = {
            i: [0,0,4,4,0,0,3,3,0,0,1,1],
            j: [1,2,5,6,1,5,2,6,3,7,2,6],
            k: [2,3,6,7,5,4,6,7,7,4,6,5]
        };
    }
    
    rotatePt(vx, vy, vz, pitch, roll, yaw) {
        const p = pitch * Math.PI / 180;
        const r = roll * Math.PI / 180;
        const y = yaw * Math.PI / 180;
        
        const cx = Math.cos(p), sx = Math.sin(p);
        const cy = Math.cos(r), sy = Math.sin(r);
        const cz = Math.cos(y), sz = Math.sin(y);
        
        let x1 = vx, y1 = vy * cx - vz * sx, z1 = vy * sx + vz * cx;
        let x2 = x1 * cy + z1 * sy, y2 = y1, z2 = -x1 * sy + z1 * cy;
        let x3 = x2 * cz - y2 * sz, y3 = x2 * sz + y2 * cz, z3 = z2;
        
        return [x3, y3, z3];
    }
    
    getRotatedSensor(pitch, roll, yaw) {
        const px = [], py = [], pz = [];
        for (const v of this.vertices) {
            const [nx, ny, nz] = this.rotatePt(v[0], v[1], v[2], pitch, roll, yaw);
            px.push(nx); py.push(ny); pz.push(nz);
        }
        const [xx, xy, xz] = this.rotatePt(1.2, 0, 0, pitch, roll, yaw);
        const [yx, yy, yz] = this.rotatePt(0, 1.2, 0, pitch, roll, yaw);
        const [zx, zy, zz] = this.rotatePt(0, 0, 1.2, pitch, roll, yaw);
        
        return {
            mesh: { x: px, y: py, z: pz },
            axX: { x: [0, xx], y: [0, xy], z: [0, xz] },
            axY: { x: [0, yx], y: [0, yy], z: [0, yz] },
            axZ: { x: [0, zx], y: [0, zy], z: [0, zz] }
        };
    }
    
    initPlotly() {
        this.traceMesh = {
            type: 'mesh3d', i: this.meshIndices.i, j: this.meshIndices.j, k: this.meshIndices.k,
            x: [], y: [], z: [], color: '#3f3f46', opacity: 0.85, name: 'Cuerpo'
        };
        this.traceX = { type: 'scatter3d', mode: 'lines', x: [], y: [], z: [],
                       line: { color: '#ef4444', width: 6 }, name: '+X (Pitch)' };
        this.traceY = { type: 'scatter3d', mode: 'lines', x: [], y: [], z: [],
                       line: { color: '#10b981', width: 6 }, name: '+Y (Roll)' };
        this.traceZ = { type: 'scatter3d', mode: 'lines', x: [], y: [], z: [],
                       line: { color: '#3282f6', width: 6 }, name: '+Z (Yaw)' };
        
        const layout = {
            uirevision: true,
            margin: { l: 0, r: 0, b: 0, t: 0 },
            paper_bgcolor: 'transparent',
            scene: {
                xaxis: { title: 'X', range: [-1.5, 1.5], showgrid: true, gridcolor: '#27272a', showbackground: false },
                yaxis: { title: 'Y', range: [-1.5, 1.5], showgrid: true, gridcolor: '#27272a', showbackground: false },
                zaxis: { title: 'Z', range: [-1.5, 1.5], showgrid: true, gridcolor: '#27272a', showbackground: false },
                camera: { eye: { x: 1.5, y: 1.5, z: 1.2 } }
            },
            showlegend: true,
            legend: { font: { color: 'white', size: 10 }, x: 0, y: 1, bgcolor: 'rgba(0,0,0,0.5)' }
        };
        
        const container = document.getElementById('plotlySensor');
        if (container && typeof Plotly !== 'undefined') {
            Plotly.newPlot('plotlySensor', [this.traceMesh, this.traceX, this.traceY, this.traceZ], layout, { responsive: true });
        }
    }
    
    update(angle) {
        if (isInteracting3D) return;
        const tab3d = document.getElementById('tab-3d');
        if (!tab3d?.classList.contains('active') || typeof Plotly === 'undefined') return;
        const rot = this.getRotatedSensor(angle.x, angle.y, angle.z);
        Plotly.restyle('plotlySensor', {
            x: [rot.mesh.x, rot.axX.x, rot.axY.x, rot.axZ.x],
            y: [rot.mesh.y, rot.axX.y, rot.axY.y, rot.axZ.y],
            z: [rot.mesh.z, rot.axX.z, rot.axY.z, rot.axZ.z]
        }, [0, 1, 2, 3]);
    }
}

// ==================== OSCILOSCOPIO ====================
class Oscilloscope {
    constructor(canvasId) {
        this.canvas = document.getElementById(canvasId);
        if (!this.canvas) return;
        this.ctx = this.canvas.getContext('2d');
        this.dataX = new Array(CONFIG.OSC_SAMPLES).fill(0);
        this.dataY = new Array(CONFIG.OSC_SAMPLES).fill(0);
        this.dataZ = new Array(CONFIG.OSC_SAMPLES).fill(0);
    }
    
    update(velX, velY, velZ) {
        this.dataX.push(velX); this.dataX.shift();
        this.dataY.push(velY); this.dataY.shift();
        this.dataZ.push(velZ); this.dataZ.shift();
        this.draw();
    }
    
    draw() {
        if (!this.ctx) return;
        const parent = this.canvas.parentElement;
        if (!parent) return;
        if (this.canvas.width !== parent.clientWidth || this.canvas.height !== parent.clientHeight) {
            this.canvas.width = parent.clientWidth;
            this.canvas.height = parent.clientHeight;
        }
        const width = this.canvas.width, height = this.canvas.height, midY = height / 2;
        this.ctx.clearRect(0, 0, width, height);
        this.drawGrid(width, height);
        this.drawZeroLine(midY, width);
        
        let maxPeak = 0;
        for (let i = 0; i < this.dataX.length; i++) {
            maxPeak = Math.max(maxPeak, Math.abs(this.dataX[i]), Math.abs(this.dataY[i]), Math.abs(this.dataZ[i]));
        }
        const scale = Math.max(20, maxPeak * 1.15);
        this.plotWave(this.dataX, '#3282f6', width, height, midY, scale);
        this.plotWave(this.dataY, '#eab308', width, height, midY, scale);
        this.plotWave(this.dataZ, '#10b981', width, height, midY, scale);
        this.ctx.fillStyle = '#6b7280';
        this.ctx.font = '11px system-ui, sans-serif';
        this.ctx.fillText(`Escala: ±${Math.round(scale)} mm/s`, 15, 22);
    }
    
    drawGrid(width, height) {
        this.ctx.strokeStyle = '#27272a';
        this.ctx.lineWidth = 1;
        this.ctx.beginPath();
        for (let i = 0; i < width; i += 40) { this.ctx.moveTo(i, 0); this.ctx.lineTo(i, height); }
        for (let j = 0; j < height; j += 30) { this.ctx.moveTo(0, j); this.ctx.lineTo(width, j); }
        this.ctx.stroke();
    }
    
    drawZeroLine(midY, width) {
        this.ctx.strokeStyle = '#3f3f46';
        this.ctx.beginPath();
        this.ctx.moveTo(0, midY);
        this.ctx.lineTo(width, midY);
        this.ctx.stroke();
    }
    
    plotWave(data, color, width, height, midY, scale) {
        this.ctx.strokeStyle = color;
        this.ctx.lineWidth = 2;
        this.ctx.beginPath();
        const step = width / (data.length - 1);
        for (let i = 0; i < data.length; i++) {
            const x = i * step;
            const y = midY - (data[i] / scale) * (midY - 5);
            if (i === 0) this.ctx.moveTo(x, y);
            else this.ctx.lineTo(x, y);
        }
        this.ctx.stroke();
    }
}

// ==================== GESTOR DE PEAKS ====================
class PeakManager {
    constructor() {
        this.maxAx = 0; this.maxAy = 0; this.maxAz = 0; this.maxVel = 0;
    }
    update(angle, vel) {
        const absAx = Math.abs(angle.x || 0);
        const absAy = Math.abs(angle.y || 0);
        const absAz = Math.abs(angle.z || 0);
        const currentMaxVel = Math.max(Math.abs(vel.x || 0), Math.abs(vel.y || 0), Math.abs(vel.z || 0));
        if (absAx > this.maxAx) { this.maxAx = absAx; updateText('peakAx', this.maxAx.toFixed(2), '°'); }
        if (absAy > this.maxAy) { this.maxAy = absAy; updateText('peakAy', this.maxAy.toFixed(2), '°'); }
        if (absAz > this.maxAz) { this.maxAz = absAz; updateText('peakAz', this.maxAz.toFixed(2), '°'); }
        if (currentMaxVel > this.maxVel) { this.maxVel = currentMaxVel; updateText('peakVel', this.maxVel, ' mm/s'); }
    }
}

// ==================== INICIALIZACIÓN ====================
const angleChart = new ChartManager('angleChart', CONFIG.COLORS);
const velChart = new ChartManager('velChart', CONFIG.COLORS);
const sphereRenderer = new SphereRenderer();
const sensorRenderer = new Sensor3DRenderer();
const oscilloscope = new Oscilloscope('oscilloscopeCanvas');
const peakManager = new PeakManager();

let isLogging = false;
let last3DUpdate = 0;
let summaryChart = null;

const sumCtx = document.getElementById('summaryChartCanvas')?.getContext('2d');
if (sumCtx) {
    summaryChart = new Chart(sumCtx, {
        type: 'line',
        data: {
            labels: Array(CONFIG.SUMMARY_SAMPLES).fill(''),
            datasets: [{
                label: 'RMS Total (mm/s)',
                borderColor: '#ef4444',
                backgroundColor: 'rgba(239, 68, 68, 0.1)',
                fill: true,
                data: Array(CONFIG.SUMMARY_SAMPLES).fill(0),
                tension: 0.3,
                borderWidth: 2,
                pointRadius: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { display: false },
                y: { grid: { color: '#27272a' }, ticks: { color: '#a1a1aa', font: { size: 10 } } }
            }
        }
    });
}

// UI Elements
const btnToggleLog = document.getElementById('btnToggleLog');
const btnExport = document.getElementById('btnExportar');
const deviceName = document.getElementById('deviceName');
const logBadge = document.getElementById('logBadge');
const btnConnect = document.getElementById('btnConectar');

if (btnConnect) {
    btnConnect.innerText = "Gestionado por PC";
    btnConnect.disabled = true;
    btnConnect.style.background = "#166534";
}

setTimeout(() => {
    setupInteractionLock('plotlySensor');
    setupInteractionLock('plotlySphere');
}, 1000);

// ==================== RENDERIZADO PRINCIPAL ====================
function renderUI(d) {
    const angle = d.angle || { x: d.pitch || 0, y: d.roll || 0, z: d.yaw || 0 };
    const vel = d.vel || { x: 0, y: 0, z: 0 };
    const disp = d.disp || { x: 0, y: 0, z: 0 };
    const freq = d.freq || { x: 0, y: 0, z: 0 };
    const tasmg = d.tasmg || { gx: 0, gy: 0, gz: -1, taSMG_val: 1 };
    const temp = d.temp || 0;
    const battery = d.battery || 100;
    
    updateText('ax', angle.x, '°');
    updateText('ay', angle.y, '°');
    updateText('az', angle.z, '°');
    updateText('vx', vel.x, ' mm/s');
    updateText('vy', vel.y, ' mm/s');
    updateText('vz', vel.z, ' mm/s');
    updateText('dx', disp.x, ' mm');
    updateText('dy', disp.y, ' mm');
    updateText('dz', disp.z, ' mm');
    updateText('fx', freq.x, ' Hz');
    updateText('fy', freq.y, ' Hz');
    updateText('fz', freq.z, ' Hz');
    updateText('temp', temp, '°C');
    updateText('batteryVal', battery, '%');
    
    const vRms = Math.sqrt(vel.x ** 2 + vel.y ** 2 + vel.z ** 2).toFixed(1);
    const dRms = Math.sqrt(disp.x ** 2 + disp.y ** 2 + disp.z ** 2).toFixed(0);
    updateText('vTotal', vRms, ' mm/s');
    updateText('dTotal', dRms, ' mm');
    
    updateText('lblPitch', formatDegrees(angle.x));
    updateText('lblRoll', formatDegrees(angle.y));
    updateText('lblYaw', formatDegrees(angle.z));
    
    updateText('lbl-tasmg', formatGForce(tasmg.taSMG_val));
    updateText('math-pitch', formatDegrees(angle.x));
    updateText('math-roll', formatDegrees(angle.y));
    updateText('math-gx', tasmg.gx.toFixed(4));
    updateText('math-gy', tasmg.gy.toFixed(4));
    updateText('math-gz', tasmg.gz.toFixed(4));
    
    updateText('math-2d-x', tasmg.gx.toFixed(4));
    updateText('math-2d-y', tasmg.gy.toFixed(4));
    const mag2D = Math.sqrt(tasmg.gx ** 2 + tasmg.gy ** 2);
    updateText('math-2d-mag', mag2D.toFixed(4), ' G');
    updateText('math-2d-ang', (Math.atan2(tasmg.gy, tasmg.gx) * 180 / Math.PI).toFixed(2), '°');
    
    if (angleChart) angleChart.update(angle.x, angle.y, angle.z);
    if (velChart) velChart.update(vel.x, vel.y, vel.z);
    
    if (summaryChart && vel) {
        summaryChart.data.datasets[0].data.push(parseFloat(vRms));
        summaryChart.data.datasets[0].data.shift();
        summaryChart.update();
    }
    
    updateText('chkValX', formatDegrees(angle.x));
    updateText('chkValY', formatDegrees(angle.y));
    updateText('chkValZ', formatDegrees(angle.z));
    updateText('chkVx', vel.x, ' mm/s');
    updateText('chkVy', vel.y, ' mm/s');
    updateText('chkVz', vel.z, ' mm/s');
    
    peakManager.update(angle, vel);
    if (oscilloscope) oscilloscope.update(vel.x, vel.y, vel.z);
    
    const now = Date.now();
    if (now - last3DUpdate > CONFIG.PLOTLY_UPDATE_THROTTLE) {
        last3DUpdate = now;
        sensorRenderer.update(angle);
    }
    
    if (typeof Plotly !== 'undefined' && tasmg) {
        const gx = parseFloat(tasmg.gx) || 0;
        const gy = parseFloat(tasmg.gy) || 0;
        const gz = parseFloat(tasmg.gz) || 0;
        sphereRenderer.updateTrajectory(gx, gy, gz);
        sphereRenderer.updatePlotly(gx, gy, gz);
    }
}

// ==================== EVENTOS Y CICLO PRINCIPAL ====================
if (btnToggleLog) {
    btnToggleLog.addEventListener('click', async () => {
        const desiredState = !isLogging;
        btnToggleLog.disabled = true;
        try {
            await fetch(`/sensor_log/${desiredState}`, { method: 'POST' });
        } catch (e) {
            console.error('Error toggling log:', e);
        } finally {
            btnToggleLog.disabled = false;
        }
    });
}

if (btnExport) {
    btnExport.addEventListener('click', () => window.open('/descargar_csv', '_blank'));
}

console.log('API endpoints disponibles:');
console.log('- /sensor_data (GET)');
console.log('- /sensor_log/{state} (POST)');
console.log('- /descargar_csv (GET)');

setInterval(async () => {
    try {
        const res = await fetch('/sensor_data');
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        const data = await res.json();
        
        if (deviceName) {
            deviceName.innerText = data.status === "Conectado" ? "WTVB01-BT50 (Conectado a PC Master)" : data.status;
        }
        
        // 1. Candado para los botones de grabación (Solo se activan si está el WTVB01 real)
        const isConnected = (data.status === "Conectado");
        if (btnToggleLog) btnToggleLog.disabled = !isConnected;
        if (btnExport) btnExport.disabled = !isConnected;
        
        // 2. Lógica de UI para la grabación
        if (isConnected) {
            if (data.is_logging !== isLogging) {
                isLogging = data.is_logging;
                if (logBadge) {
                    logBadge.innerText = isLogging ? "🔴 Grabando en PC" : "⏹️ Grabación Detenida";
                    logBadge.className = isLogging ? "badge log-active" : "badge log-inactive";
                }
                if (btnToggleLog) {
                    btnToggleLog.innerText = isLogging ? "Detener Grabación" : "🔴 Iniciar Grabación";
                    btnToggleLog.classList.toggle('active', isLogging);
                }
            }
            if (isLogging && document.getElementById('recordCount')) {
                document.getElementById('recordCount').innerText = data.csv_count || 0;
            }
        }
        
        // 3. ¡LA MAGIA! Renderizamos la UI SIEMPRE, para que el Plan B (MPU6050) pueda brillar
        renderUI(data);
        
    } catch (e) {
        console.error('Error en ciclo de telemetría:', e);
        if (deviceName) deviceName.innerText = "Error de red con la PC";
    }
}, CONFIG.UPDATE_INTERVAL);

window.addEventListener('resize', () => oscilloscope?.draw());

console.log('✅ Dashboard inicializado correctamente');
console.log('💡 La estela TASMG ahora es persistente y con escala dinámica sensible');