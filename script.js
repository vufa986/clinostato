document.addEventListener('DOMContentLoaded', () => {
    // --- MODO DE DESARROLLO ---
    const DEVELOPMENT_MODE = false; 

    let isPwrOn = false, isRunOn = false;
    let telemetryInterval;
    
    // Variables Globales de Estado y Uptime
    let sysStartTime = Date.now();
    let motorRunTime = { A: 0, B: 0 };
    let motorLastTick = { A: Date.now(), B: Date.now() };
    const currentRPMs = { A: 0.0, B: 0.0 };
    
    // Objeto Global para Automatización
    window.autoState = {
        offTime: null,
        routines: {
            A: { active: false, step: 1, nextSwitch: 0, r1:0, s1:0, r2:0, s2:0 },
            B: { active: false, step: 1, nextSwitch: 0, r1:0, s1:0, r2:0, s2:0 }
        }
    };

    // NUEVO: Memoria para el Auto-Cambio de Dirección
    let dirTimers = {
        A: { interval: 0, lastSwitch: Date.now() },
        B: { interval: 0, lastSwitch: Date.now() }
    };

    const ui = {
        loader: document.getElementById('loader'), main: document.getElementById('main-content'),
        console: document.getElementById('console-output'),
        liveA: document.getElementById('live-mvA'), liveB: document.getElementById('live-mvB')
    };

    const ctx = document.getElementById('telemetryChart').getContext('2d');
    const liveChart = new Chart(ctx, { 
        type: 'line', 
        data: { labels: Array(30).fill(''), datasets: [
            { label: 'AXIS X', data: Array(30).fill(0), borderColor: '#ff6b00', borderWidth: 2, tension: 0.4, pointRadius: 0 },
            { label: 'AXIS Y', data: Array(30).fill(0), borderColor: '#d070ff', borderWidth: 2, tension: 0.4, pointRadius: 0 }
        ]}, 
        options: { responsive: true, maintainAspectRatio: false, scales: { y: { display: true, ticks: { color: '#ffffff' }, grid: { color: 'rgba(255,255,255,0.1)' } }, x: { display: false } }, plugins: { legend: { display: false } }, animation: false } 
    });

    const logToConsole = (msg, type = 'INFO') => {
        if (!DEVELOPMENT_MODE && type === 'DEBUG_POLLING') return;

        let color = type === 'ERROR' || type === 'EMERGENCY' ? '#ff1030' : (type === 'POWER' || type === 'ENGINE' ? '#ff007f' : '#00f2ff');
        const newLine = document.createElement('div');
        newLine.innerHTML = `<span style="color:#71717a">[${new Date().toLocaleTimeString()}]</span> <span style="color:${color};font-weight:bold;">[${type}]</span> ${msg}`;
        ui.console.appendChild(newLine);
        while (ui.console.children.length > 40) ui.console.removeChild(ui.console.firstChild);
        ui.console.scrollTop = ui.console.scrollHeight;
    };

    function formatTime(ms) {
        let totalSecs = Math.floor(ms / 1000);
        let hours = Math.floor(totalSecs / 3600);
        let mins = Math.floor((totalSecs % 3600) / 60);
        let secs = totalSecs % 60;
        return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }

    const paramsConfig = [
        { k: "Arrancar", desc: "Comando de arranque activo." }, 
        { k: "Activar", desc: "Equipos habilitados (Power)." },
        { k: "Velocidad", desc: "Velocidad física enviada al servomotor." }, 
        { k: "Sentido", desc: "1=Horario, 2=Antihorario." },
        { k: "Limite_Torque", desc: "Límite de fuerza establecido." }
    ];

    const initTable = () => {
        document.getElementById('dashboard-table').innerHTML = `<table><thead><tr><th>Parámetro</th><th>V90 (A)</th><th>S210 (B)</th><th>Descripción</th></tr></thead><tbody id="tBody"></tbody></table>`;
        document.getElementById('tBody').innerHTML = paramsConfig.map(p => `<tr id="row-${p.k}"><td>${p.k}</td><td class="v90">0</td><td class="s210">0</td><td class="desc">${p.desc}</td></tr>`).join('');
    };

    const updateTable = (d1, d2) => {
        paramsConfig.forEach(p => {
            const r = document.getElementById(`row-${p.k}`);
            if(!r) return;
            const format = (v) => typeof v === 'boolean' ? (v ? '<span class="table-val-true">TRUE</span>' : '<span class="table-val-false">FALSE</span>') : (typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(2) : v);
            r.querySelector('.v90').innerHTML = format(d1[p.k]);
            r.querySelector('.s210').innerHTML = format(d2[p.k]);
        });
    };
    initTable();

    // --- ARRANQUE INMEDIATO DEL POLLING ---
    setTimeout(() => { 
        if (ui.loader) ui.loader.style.opacity = '0'; 
        setTimeout(() => { 
            if (ui.loader) ui.loader.style.display = 'none'; 
            if (ui.main) ui.main.style.display = 'block'; 
            logToConsole("System Initialized and ready.", "INFO"); 
            startTelemetryPolling(); 
        }, 800); 
    }, 1500); 

    // --- GESTIÓN DE PERMISOS VISUALES ---
    let lastPermissionStatus = null;
    function updatePermissionBadge(isMaster) {
        if (lastPermissionStatus === isMaster) return;
        lastPermissionStatus = isMaster;

        const badge = document.getElementById('control-badge');
        if(badge) {
            badge.style.display = 'block';
            if (isMaster) {
                badge.style.border = "1px solid #00ff95";
                badge.style.color = "#00ff95";
                badge.style.background = "rgba(0, 255, 149, 0.1)";
                badge.innerText = "👑 MODO MAESTRO";
            } else {
                badge.style.border = "1px solid var(--neon-red)";
                badge.style.color = "var(--neon-red)";
                badge.style.background = "rgba(255, 16, 48, 0.1)";
                badge.innerText = "👁️ MODO OBSERVADOR (CONTROL OCUPADO)";
            }
        }
    }

    // --- BOTONES ---
    window.togglePower = async (forceState = null) => {
        let desiredState = forceState !== null ? forceState : !isPwrOn;
        try { 
            const res = await fetch(`/motor/power/${desiredState}`, { method: 'POST' }); 
            const data = await res.json();
            if (data.status === "DENIED") logToConsole("Acceso denegado: Observador activo.", "ERROR");
        } catch(e) {}
    };

    window.toggleStart = async () => {
        if(!isPwrOn) return alert("ACTIVATE SYSTEM POWER FIRST");
        let desiredState = !isRunOn;
        try { 
            const res = await fetch(`/motor/start/${desiredState}`, { method: 'POST' }); 
            const data = await res.json();
            if (data.status === "DENIED") logToConsole("Acceso denegado: Observador activo.", "ERROR");
        } catch(e) {}
    };

    window.updateExtras = async (m) => {
        try { 
            const res = await fetch(`/extra/${m}/${document.getElementById(`dir${m}`).value}/${document.getElementById(`mv${m}`).value}/${document.getElementById(`torque${m}`).value}`, { method: 'POST' }); 
            const data = await res.json();
            if (data.status === "DENIED") {
                document.getElementById(`mv${m}`).value = "0.0";
                document.getElementById(`torque${m}`).value = "0.0";
            }
        } catch(e){}
    };

    // NUEVA FUNCIÓN AÑADIDA: Actualiza la memoria local de la dirección automática
    window.updateAutoDir = (m) => {
        let val = parseInt(document.getElementById(`autoDir${m}`).value);
        if (isNaN(val) || val < 0) val = 0;
        dirTimers[m].interval = val;
        dirTimers[m].lastSwitch = Date.now(); // Resetea el contador al cambiar el valor
    };

    // --- LÓGICA DE AUTOMATIZACIÓN (CRONÓMETROS) ---
    window.toggleAutoOff = () => {
        let mins = parseFloat(document.getElementById('autoOffMins').value);
        let btn = document.getElementById('btnAutoOff');
        let status = document.getElementById('statusAutoOff');

        if (autoState.offTime) {
            autoState.offTime = null;
            btn.innerText = "Iniciar";
            btn.style.background = "";
            btn.style.borderColor = "var(--neon-cyan)";
            status.innerText = "Inactivo";
            status.style.color = "#eab308";
        } else {
            if (isNaN(mins) || mins <= 0) return alert("Ingrese un tiempo válido en minutos.");
            autoState.offTime = Date.now() + (mins * 60000);
            btn.innerText = "Cancelar Cronómetro";
            btn.style.background = "var(--neon-red)";
            btn.style.borderColor = "var(--neon-red)";
            btn.style.color = "white";
        }
    };

    window.toggleRoutine = (m) => {
        let r = autoState.routines[m];
        let btn = document.getElementById(`btnAuto${m}`);
        let status = document.getElementById(`statusAuto${m}`);

        if (r.active) {
            r.active = false;
            btn.innerText = "Activar Ciclo";
            btn.style.background = "";
            btn.style.borderColor = "var(--neon-cyan)";
            btn.style.color = "var(--neon-cyan)";
            status.innerText = "Inactivo";
            status.style.color = "#eab308";
        } else {
            if(!isPwrOn || !isRunOn) return alert("Encienda el sistema (POWER) y la marcha (START) primero para automatizar los ejes.");
            
            r.r1 = parseFloat(document.getElementById(`ax${m}_rpm1`).value) || 0;
            r.s1 = parseFloat(document.getElementById(`ax${m}_sec1`).value) || 0;
            r.r2 = parseFloat(document.getElementById(`ax${m}_rpm2`).value) || 0;
            r.s2 = parseFloat(document.getElementById(`ax${m}_sec2`).value) || 0;

            if(r.s1 <= 0 || r.s2 <= 0) return alert("Los tiempos de cada fase deben ser mayores a 0 segundos.");

            r.active = true;
            r.step = 1;
            r.nextSwitch = Date.now() + (r.s1 * 1000);
            
            let input = document.getElementById(`manualRpm${m}`);
            input.value = r.r1.toFixed(3);
            input.dispatchEvent(new Event('change'));

            btn.innerText = "Detener Ciclo";
            btn.style.background = "var(--neon-red)";
            btn.style.borderColor = "var(--neon-red)";
            btn.style.color = "white";
        }
    };

    // Bucle para actualizar los relojes (UPTIME) y Rutinas (Cada 100ms)
    setInterval(() => {
        const now = Date.now();
        document.getElementById('sys-uptime').innerText = `⏱️ SYS UPTIME: ${formatTime(now - sysStartTime)}`;
        
        ['A', 'B'].forEach(m => {
            let isRunning = (isPwrOn && isRunOn && currentRPMs[m] > 0);
            
            // --- ACTUALIZACIÓN DE RELOJES DE MARCHA ---
            if (isRunning) motorRunTime[m] += (now - motorLastTick[m]);
            motorLastTick[m] = now;
            
            let timerEl = document.getElementById(`timer${m}`);
            if(timerEl) {
                timerEl.innerText = `⏱️ ${formatTime(motorRunTime[m])} en marcha`;
                timerEl.style.color = isRunning ? "#00ff95" : "#71717a";
                timerEl.style.textShadow = isRunning ? "0 0 5px rgba(0, 255, 149, 0.5)" : "none";
            }

            // --- NUEVO: EJECUCIÓN DEL AUTO CAMBIO DE DIRECCIÓN ---
            if (isRunning && dirTimers[m].interval > 0) {
                if (now - dirTimers[m].lastSwitch >= (dirTimers[m].interval * 1000)) {
                    let dirSelect = document.getElementById(`dir${m}`);
                    // Cambia visualmente en la web de Horario(1) a Antihorario(2) y viceversa
                    dirSelect.value = dirSelect.value === "1" ? "2" : "1";
                    
                    // Llama a la función que actualiza todo y envía al servidor Python
                    window.updateExtras(m); 
                    
                    logToConsole(`AXIS ${m === 'A' ? 'X' : 'Y'} AUTO-DIR: Cambiando a sentido ${dirSelect.value === '1' ? 'Horario' : 'Antihorario'}`, "INFO");
                    dirTimers[m].lastSwitch = now;
                }
            } else {
                // Si el motor no está corriendo o el auto-dir es 0, no sumamos tiempo de espera.
                dirTimers[m].lastSwitch = now; 
            }

            // --- EJECUCIÓN DE RUTINAS CÍCLICAS DE VELOCIDAD ---
            let r = autoState.routines[m];
            if (r.active) {
                let remain = r.nextSwitch - now;
                if (remain <= 0) {
                    r.step = r.step === 1 ? 2 : 1;
                    let nextRpm = r.step === 1 ? r.r1 : r.r2;
                    let nextSecs = r.step === 1 ? r.s1 : r.s2;
                    r.nextSwitch = now + (nextSecs * 1000);
                    
                    let input = document.getElementById(`manualRpm${m}`);
                    input.value = nextRpm.toFixed(3);
                    input.dispatchEvent(new Event('change')); // Dispara la orden al servidor
                    remain = nextSecs * 1000;
                }
                document.getElementById(`statusAuto${m}`).innerText = `Fase ${r.step} (${(r.step===1?r.r1:r.r2)} RPM) - Siguiente en ${(remain/1000).toFixed(1)}s`;
                document.getElementById(`statusAuto${m}`).style.color = "#00ff95";
            }
        });

        // Ejecución de Apagado Automático
        if (autoState.offTime) {
            let remain = autoState.offTime - now;
            if (remain <= 0) {
                autoState.offTime = null;
                document.getElementById('statusAutoOff').innerText = "Sistema Apagado por Cronómetro.";
                document.getElementById('statusAutoOff').style.color = "var(--neon-red)";
                if (isPwrOn) window.togglePower(false); // Ordena apagar
                
                let btn = document.getElementById('btnAutoOff');
                btn.innerText = "Iniciar";
                btn.style.background = "";
                btn.style.borderColor = "var(--neon-cyan)";
                btn.style.color = "var(--neon-cyan)";
            } else {
                document.getElementById('statusAutoOff').innerText = `El sistema se apagará en: ${formatTime(remain)}`;
                document.getElementById('statusAutoOff').style.color = "#00ff95";
            }
        }
    }, 100); 

    // --- DIALES INTELIGENTES ---
    function setupMotor(id) {
        const dial = document.getElementById(`dial${id === 'A' ? 'X' : 'Y'}Container`).firstElementChild;
        const needle = dial.querySelector('.dial-needle-container');
        const readout = document.getElementById(`val${id}-center`);
        const bgRotator = document.getElementById(`bgRotator${id}`);
        const manualInput = document.getElementById(`manualRpm${id}`);
        let tAxis, isDragging = false;
        let lastTheta = null; 

        setInterval(() => { 
            let visualRpm = currentRPMs[id] > 100 ? 100 : currentRPMs[id]; 
            bgRotator.style.animationDuration = (isPwrOn && isRunOn && visualRpm > 0) ? `${20/visualRpm}s` : '0s'; 
        }, 100);

        const updateDialUI = (rpm, sendToServer = true) => {
            currentRPMs[id] = parseFloat(rpm); 
            
            readout.innerText = currentRPMs[id] > 999 ? currentRPMs[id].toFixed(0) : currentRPMs[id].toFixed(1); 
            
            if (manualInput && document.activeElement !== manualInput) {
                manualInput.value = currentRPMs[id].toFixed(3);
            }
            
            needle.style.transform = `rotate(${(currentRPMs[id]/10)*360}deg)`;
            
            if (sendToServer) {
                clearTimeout(tAxis); 
                tAxis = setTimeout(async () => {
                    try {
                        const res = await fetch(`/control/${id}/${currentRPMs[id].toFixed(3)}`, { method: 'POST' });
                        const data = await res.json();
                        if (data.status === "DENIED") updateDialUI(0, false); 
                    } catch(e){}
                }, 250);
            }
        };

        if (manualInput) {
            manualInput.addEventListener('change', (e) => {
                let val = parseFloat(e.target.value);
                if (isNaN(val)) val = 0.0;
                if (val < 0) val = 0.0;
                if (val > 5000) val = 5000.0;
                
                e.target.value = val.toFixed(3);
                updateDialUI(val, true); 
            });
            manualInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') manualInput.blur();
            });
        }

        const onMove = (e) => {
            if (!isDragging) return; 
            e.preventDefault();
            const rect = dial.getBoundingClientRect(), cx = rect.left + rect.width/2, cy = rect.top + rect.height/2;
            let theta = Math.atan2((e.touches?e.touches[0].clientY:e.clientY)-cy, (e.touches?e.touches[0].clientX:e.clientX)-cx)*180/Math.PI + 90;
            if (theta < 0) theta += 360;
            
            if (lastTheta !== null) {
                let delta = theta - lastTheta;
                if (delta > 180) delta -= 360;
                else if (delta < -180) delta += 360;

                let newRPM = currentRPMs[id] + (delta / 360) * 10;
                
                if (newRPM < 0) newRPM = 0.0;
                if (newRPM > 5000) newRPM = 5000.0;

                updateDialUI(newRPM, true);
            }
            lastTheta = theta; 
        };

        const resetDrag = () => { isDragging = false; lastTheta = null; };

        dial.addEventListener('mousedown', (e) => { isDragging = true; lastTheta = null; onMove(e); }); 
        window.addEventListener('mouseup', resetDrag); 
        window.addEventListener('mousemove', onMove);
        
        dial.addEventListener('touchstart', (e) => { isDragging = true; lastTheta = null; onMove(e); }, {passive:false}); 
        window.addEventListener('touchend', resetDrag); 
        window.addEventListener('touchmove', onMove, {passive:false});
        
        window.addEventListener('resetDials', () => updateDialUI(0, false)); 
        updateDialUI(0, false);
    }
    setupMotor('A'); setupMotor('B');

    // --- CEREBRO DE SINCRONIZACIÓN ---
    function startTelemetryPolling() {
        telemetryInterval = setInterval(async () => {
            try {
                const res = await fetch('/telemetry'); const d = await res.json();
                if (d.status === "OK") {
                    const vA = Math.abs(d.v90.Velocidad_Hacia || 0), vB = Math.abs(d.s210.Velocidad_Hacia || 0);
                    ui.liveA.innerHTML = `${vA.toFixed(2)}<span>RPM</span>`; 
                    ui.liveB.innerHTML = `${vB.toFixed(2)}<span>RPM</span>`;
                    liveChart.data.datasets[0].data.push(vA); liveChart.data.datasets[0].data.shift();
                    liveChart.data.datasets[1].data.push(vB); liveChart.data.datasets[1].data.shift();
                    liveChart.update();
                    updateTable(d.v90, d.s210);
                    
                    isPwrOn = d.v90.Activar;
                    isRunOn = d.v90.Arrancar;

                    const btnPwr = document.getElementById('pwrBtn');
                    if (btnPwr.classList.contains('pwr-on') !== isPwrOn) {
                        btnPwr.classList.toggle('pwr-on', isPwrOn);
                        btnPwr.innerText = isPwrOn ? "SYSTEM POWER: ON" : "SYSTEM POWER: OFF";
                        document.getElementById('live-telemetry').className = isPwrOn ? 'live-indicator status-on' : 'live-indicator status-off';
                        if(!isPwrOn) window.dispatchEvent(new CustomEvent('resetDials'));
                    }

                    const btnStr = document.getElementById('strBtn');
                    if (btnStr.classList.contains('str-on') !== isRunOn) {
                        btnStr.classList.toggle('str-on', isRunOn);
                        btnStr.innerText = isRunOn ? "ENGINE: RUNNING" : "START ENGINE";
                    }
                    
                    if (d.is_master !== undefined) updatePermissionBadge(d.is_master);
                }
            } catch (e) {}
        }, 300);
    }

    document.getElementById('panicButton').onclick = async () => {
        try { 
            await fetch('/emergency', { method: 'POST' }); 
        } catch(e){}
        logToConsole("EMERGENCY COMMAND SENT.", "EMERGENCY"); 
        
        // Reset local visual para las cajas manuales adicionales
        document.getElementById('manualRpmA').value = "0.000";
        document.getElementById('manualRpmB').value = "0.000";
        document.getElementById('torqueA').value = "0.0";
        document.getElementById('torqueB').value = "0.0";
        document.getElementById('mvA').value = "0.0";
        document.getElementById('mvB').value = "0.0";
        
        // Reset del AUTO DIR
        document.getElementById('autoDirA').value = "0";
        document.getElementById('autoDirB').value = "0";
        window.updateAutoDir('A');
        window.updateAutoDir('B');

        // Detener todas las rutinas de automatización por seguridad
        ['A', 'B'].forEach(m => {
            if(autoState.routines[m].active) window.toggleRoutine(m);
        });
        if(autoState.offTime) window.toggleAutoOff();
        
        // Reset de los cronómetros locales
        motorRunTime = { A: 0, B: 0 };
    };
});

document.querySelector('.automation-header').addEventListener('click', function() {
    const body = document.getElementById('autoBody');
    body.classList.toggle('show');
    
    // Activar/desactivar scroll según el estado del panel
    if (body.classList.contains('show')) {
        document.body.style.overflowY = 'auto';
    } else {
        document.body.style.overflowY = 'hidden';
    }
});