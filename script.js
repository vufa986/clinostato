document.addEventListener('DOMContentLoaded', () => {
    const loader = document.getElementById('loader');
    const main = document.getElementById('main-content');
    
    let isPwrOn = false;
    let isRunOn = false;
    let autoDirTimers = { A: null, B: null };
    let telemetryInterval;

    // Configuración de la gráfica de Chart.js
    const ctx = document.getElementById('telemetryChart').getContext('2d');
    const liveChart = new Chart(ctx, { 
        type: 'line', 
        data: { labels: Array(30).fill(''), datasets: [
            { label: 'AXIS X', data: Array(30).fill(0), borderColor: '#ff6b00', borderWidth: 2, tension: 0.4, pointRadius: 0 },
            { label: 'AXIS Y', data: Array(30).fill(0), borderColor: '#d070ff', borderWidth: 2, tension: 0.4, pointRadius: 0 }
        ]}, 
        options: { 
            responsive: true, 
            maintainAspectRatio: false, 
            scales: { 
                y: { 
                    display: true,
                    ticks: { color: '#ffffff', font: { weight: 'bold' } }, 
                    grid: { color: 'rgba(255,255,255,0.1)' } 
                }, 
                x: { display: false } 
            }, 
            plugins: { legend: { display: false } }, 
            animation: false 
        } 
    });

    // Función de registro en la consola
    function logToConsole(message, type = 'INFO') {
        const consoleBody = document.getElementById('console-output');
        const time = new Date().toLocaleTimeString();
        const newEntry = document.createElement('div');
        let typeColor = type === 'ERROR' || type === 'EMERGENCY' ? '#ff1030' : (type === 'POWER' || type === 'ENGINE' ? '#ff007f' : '#00f2ff');
        newEntry.innerHTML = `<span style="color: rgba(255,255,255,0.4)">[${time}]</span> <span style="color: ${typeColor}; font-weight: bold;">[${type}]</span> ${message}`;
        consoleBody.appendChild(newEntry);
        consoleBody.scrollTop = consoleBody.scrollHeight;
    }

    // RESET DE UI A 0
    function resetUI() {
        document.getElementById('valA-center').innerText = "0.0";
        document.getElementById('valB-center').innerText = "0.0";
        
        document.getElementById('live-mvA').innerHTML = "0.00<span>RPM</span>";
        document.getElementById('live-mvB').innerHTML = "0.00<span>RPM</span>";

        document.getElementById('mvA').value = "0.0";
        document.getElementById('mvB').value = "0.0";
        document.getElementById('autoDirA').value = "0";
        document.getElementById('autoDirB').value = "0";
        document.getElementById('torqueA').value = "0.0";
        document.getElementById('torqueB').value = "0.0";

        document.getElementById('dirA').value = "1";
        document.getElementById('dirB').value = "1";
        
        // Planchar la gráfica a ceros
        liveChart.data.datasets[0].data = Array(30).fill(0);
        liveChart.data.datasets[1].data = Array(30).fill(0);
        liveChart.update();
        
        logToConsole("UI Reset complete. All parameters at 0.", "RESET");
    }

    window.addEventListener('load', () => {
        setTimeout(() => {
            loader.style.opacity = '0';
            setTimeout(() => { 
                loader.style.display = 'none'; 
                main.style.display = 'block'; 
                logToConsole("System Initialized and ready.", "INFO");
            }, 800);
        }, 3200); 
    });

    window.togglePower = async () => {
        isPwrOn = !isPwrOn;
        const btn = document.getElementById('pwrBtn');
        btn.classList.toggle('pwr-on', isPwrOn); 
        btn.innerText = isPwrOn ? "SYSTEM POWER: ON" : "SYSTEM POWER: OFF";

        // Cambio dinámico del indicador de Telemetría (Rojo a Verde Neón)
        const tel = document.getElementById('live-telemetry');
        tel.className = isPwrOn ? 'live-indicator status-on' : 'live-indicator status-off';

        logToConsole(`System Power set to ${isPwrOn ? 'ON' : 'OFF'}.`, "POWER");

        try { 
            await fetch(`http://127.0.0.1:8000/motor/power/${isPwrOn}`, { method: 'POST' }); 
        } catch(e){}

        if (!isPwrOn) {
            stopSystem();
            resetUI();
            window.dispatchEvent(new CustomEvent('resetDials'));
        }
    };

    window.toggleStart = async () => {
        if(!isPwrOn) return alert("ACTIVATE SYSTEM POWER FIRST");
        isRunOn = !isRunOn;
        const btn = document.getElementById('strBtn');
        btn.classList.toggle('str-on', isRunOn); 
        btn.innerText = isRunOn ? "ENGINE: RUNNING" : "START ENGINE";

        logToConsole(isRunOn ? "Engine started. Telemetry active." : "Engine stopped.", "ENGINE");

        try { 
            await fetch(`http://127.0.0.1:8000/motor/start/${isRunOn}`, { method: 'POST' }); 
        } catch(e){}

        if (isRunOn) {
            startTelemetryPolling();
        } else {
            stopSystem();
            resetUI();
            window.dispatchEvent(new CustomEvent('resetDials'));
        }
    };

    function stopSystem() {
        isRunOn = false;
        clearInterval(telemetryInterval);
        const btn = document.getElementById('strBtn');
        btn.classList.remove('str-on');
        btn.innerText = 'START ENGINE';
        logToConsole("System operations halted.");
    }

    async function sendToPLC(motor, val) {
        try { await fetch(`http://127.0.0.1:8000/control/${motor}/${val}`, { method: 'POST' }); } catch(e){}
    }

    window.updateExtras = async (motor) => {
        const s = document.getElementById(`dir${motor}`).value;
        const r = document.getElementById(`mv${motor}`).value;
        const t = document.getElementById(`torque${motor}`).value;
        logToConsole(`Settings updated for Axis ${motor}.`, "UPDATE");
        try { await fetch(`http://127.0.0.1:8000/extra/${motor}/${s}/${r}/${t}`, { method: 'POST' }); } catch(e){}
    };

    window.updateAutoDir = (motor) => {
        const sec = parseFloat(document.getElementById(`autoDir${motor}`).value);
        logToConsole(`Auto direction time set to ${sec}s for Axis ${motor}.`, "UPDATE");
        if(autoDirTimers[motor]) clearInterval(autoDirTimers[motor]); 
        if(sec >= 1) {
            autoDirTimers[motor] = setInterval(() => {
                const dirSelect = document.getElementById(`dir${motor}`);
                dirSelect.value = (dirSelect.value === "1") ? "2" : "1";
                window.updateExtras(motor);
            }, sec * 1000); 
        }
    };

    function setupMotor(id) {
        const cid = id === 'A' ? 'dialXContainer' : 'dialYContainer';
        const dial = document.getElementById(cid);
        const needle = dial.querySelector('.dial-needle-container');
        const readout = document.getElementById('val' + id + '-center');
        const bgRotator = document.getElementById('bgRotator' + id);
        
        const MAX_RPM = 10;
        let tAxis; 
        let isDragging = false;
        let currentRPM = 0.0; 

        const checkRotationStatus = () => {
            if (isPwrOn && isRunOn && currentRPM > 0) {
                let speed = 20 / currentRPM; 
                bgRotator.style.animationDuration = `${speed}s`;
                
                const dirSelect = document.getElementById(`dir${id}`);
                bgRotator.style.animationDirection = dirSelect && dirSelect.value === "2" ? "reverse" : "normal";
            } else {
                bgRotator.style.animationDuration = '0s'; 
            }
        };

        setInterval(checkRotationStatus, 100);

        const updateDialUI = (rpm, forceReset = false) => {
            if (!forceReset && Math.abs(rpm - currentRPM) > 8.5) return; 

            currentRPM = rpm;
            readout.innerText = currentRPM.toFixed(1);
            
            const angle = (currentRPM / MAX_RPM) * 360;
            needle.style.transform = `rotate(${angle}deg)`;

            clearTimeout(tAxis);
            tAxis = setTimeout(()=>sendToPLC(id, currentRPM.toFixed(1)), 300);
        };

        const onMove = (e) => {
            if (!isDragging) return;
            e.preventDefault(); 
            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            const clientY = e.touches ? e.touches[0].clientY : e.clientY;
            const rect = dial.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;

            let theta = Math.atan2(clientY - cy, clientX - cx) * 180 / Math.PI;
            if (theta < 0) theta = 360 + theta;
            theta = (theta + 90) % 360;
            const rpm = (theta / 360) * MAX_RPM;
            updateDialUI(rpm);
        };

        dial.addEventListener('mousedown', () => isDragging = true);
        window.addEventListener('mouseup', () => isDragging = false);
        window.addEventListener('mousemove', onMove);
        dial.addEventListener('touchstart', () => isDragging = true, {passive: false});
        window.addEventListener('touchend', () => isDragging = false);
        window.addEventListener('touchmove', onMove, {passive: false});

        window.addEventListener('resetDials', () => {
            updateDialUI(0.0, true); 
        });

        updateDialUI(0.0, true);
    }
    
    setupMotor('A'); 
    setupMotor('B');

    // Polling de telemetría a la API
    function startTelemetryPolling() {
        telemetryInterval = setInterval(async () => {
            try {
                const res = await fetch('http://127.0.0.1:8000/telemetry');
                const data = await res.json();
                if (data.status === "OK") {
                    document.getElementById('live-mvA').innerHTML = `${data.v90_mv.toFixed(2)}<span>RPM</span>`;
                    document.getElementById('live-mvB').innerHTML = `${data.s210_mv.toFixed(2)}<span>RPM</span>`;
                    liveChart.data.datasets[0].data.push(data.v90_mv); liveChart.data.datasets[0].data.shift();
                    liveChart.data.datasets[1].data.push(data.s210_mv); liveChart.data.datasets[1].data.shift();
                    liveChart.update();
                }
            } catch (e) { }
        }, 200);
    }

    // BOTÓN DE PÁNICO
    document.getElementById('panicButton').onclick = async () => {
        try { 
            await fetch('http://127.0.0.1:8000/emergency', { method: 'POST' }); 
        } catch(e) {
            console.error("Error en conexión PLC durante emergencia");
        }

        isPwrOn = false; isRunOn = false;
        const pwrBtn = document.getElementById('pwrBtn');
        const strBtn = document.getElementById('strBtn');
        pwrBtn.classList.remove('pwr-on'); pwrBtn.innerText = "SYSTEM POWER: OFF";
        strBtn.classList.remove('str-on'); strBtn.innerText = "START ENGINE";
        document.getElementById('live-telemetry').className = 'live-indicator status-off';

        logToConsole("EMERGENCY RESET ACTIVATED. ALL SYSTEMS HALTED.", "EMERGENCY");

        ['A', 'B'].forEach(motor => {            
            if(autoDirTimers[motor]) { 
                clearInterval(autoDirTimers[motor]); 
                autoDirTimers[motor] = null; 
            }
        });

        window.dispatchEvent(new CustomEvent('resetDials'));
        resetUI();
        stopSystem();
    };
});

// --- PUENTE DE ESCUCHA: DATOS EN VIVO DESDE WITMOTION ---
window.addEventListener('message', (event) => {
    const msg = event.data;
    
    // Validamos que el mensaje sea el que nos interesa
    if (msg && msg.type === 'WITMOTION_TELEMETRY') {
        const data = msg.payload;

        // 1. Encender indicador LIVE TELEMETRY si estaba apagado
        const liveIndicator = document.getElementById('live-telemetry');
        if (liveIndicator && liveIndicator.classList.contains('status-off')) {
            liveIndicator.className = "live-indicator status-on";
        }

        // 2. Imprimir datos en la consola SCADA del HUD
        const consoleOutput = document.getElementById('console-output');
        if (consoleOutput) {
            const logLine = document.createElement('div');
            logLine.innerHTML = `<span style="color:#71717a">[${data.timestamp}]</span> <span style="color:#00f2ff">[BLE SENSOR]</span> Ángulos -> X: <b>${data.pitch}°</b> | Y: <b>${data.roll}°</b>`;
            
            consoleOutput.appendChild(logLine);
            consoleOutput.scrollTop = consoleOutput.scrollHeight; // Auto-scroll
            
            // Limitar a 30 líneas para no saturar el DOM del iframe
            if (consoleOutput.children.length > 30) {
                consoleOutput.removeChild(consoleOutput.firstChild);
            }
        }
    }
});