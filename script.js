document.addEventListener('DOMContentLoaded', () => {
    let isPwrOn = false, isRunOn = false;
    let telemetryInterval;
    
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

    // Sutil modificación en script.js para proteger la consola visual
    const logToConsole = (msg, type = 'INFO') => {
        // Si el sistema está en producción, ignoramos los mensajes repetitivos de polling
        if (!DEVELOPMENT_MODE && type === 'DEBUG_POLLING') return;

        let color = type === 'ERROR' || type === 'EMERGENCY' ? '#ff1030' : (type === 'POWER' || type === 'ENGINE' ? '#ff007f' : '#00f2ff');
        const newLine = document.createElement('div');
        newLine.innerHTML = `<span style="color:#71717a">[${new Date().toLocaleTimeString()}]</span> <span style="color:${color};font-weight:bold;">[${type}]</span> ${msg}`;
        ui.console.appendChild(newLine);
        while (ui.console.children.length > 40) ui.console.removeChild(ui.console.firstChild);
        ui.console.scrollTop = ui.console.scrollHeight;
    };

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

// --- ARRANQUE INMEDIATO DEL POLLING (Sin bloqueos) ---
    setTimeout(() => { 
        if (ui.loader) ui.loader.style.opacity = '0'; 
        setTimeout(() => { 
            if (ui.loader) ui.loader.style.display = 'none'; 
            if (ui.main) ui.main.style.display = 'block'; 
            logToConsole("System Initialized and ready.", "INFO"); 
            startTelemetryPolling(); 
        }, 800); 
    }, 1500); // 1.5 segundos de carga fija y se abre el panel

    // --- GESTIÓN DE PERMISOS VISUALES (Sin spam en la consola) ---
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

    // --- BOTONES: Solo mandan peticiones, no manipulan el UI directo ---
    window.togglePower = async () => {
        let desiredState = !isPwrOn;
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

    // --- DIALES INTELIGENTES ---
    function setupMotor(id) {
        const dial = document.getElementById(`dial${id === 'A' ? 'X' : 'Y'}Container`).firstElementChild;
        const needle = dial.querySelector('.dial-needle-container');
        const readout = document.getElementById(`val${id}-center`);
        const bgRotator = document.getElementById(`bgRotator${id}`);
        let tAxis, isDragging = false, currentRPM = 0.0;

        setInterval(() => { bgRotator.style.animationDuration = (isPwrOn && isRunOn && currentRPM > 0) ? `${20/currentRPM}s` : '0s'; }, 100);

        const updateDialUI = (rpm, sendToServer = true) => {
            currentRPM = rpm; 
            readout.innerText = currentRPM.toFixed(1); 
            needle.style.transform = `rotate(${(currentRPM/10)*360}deg)`;
            
            if (sendToServer) {
                clearTimeout(tAxis); 
                tAxis = setTimeout(async () => {
                    try {
                        const res = await fetch(`/control/${id}/${currentRPM.toFixed(1)}`, { method: 'POST' });
                        const data = await res.json();
                        if (data.status === "DENIED") updateDialUI(0, false); // Efecto resorte si es observador
                    } catch(e){}
                }, 250);
            }
        };

        const onMove = (e) => {
            if (!isDragging) return; e.preventDefault();
            const rect = dial.getBoundingClientRect(), cx = rect.left + rect.width/2, cy = rect.top + rect.height/2;
            let theta = Math.atan2((e.touches?e.touches[0].clientY:e.clientY)-cy, (e.touches?e.touches[0].clientX:e.clientX)-cx)*180/Math.PI + 90;
            if (theta < 0) theta += 360;
            
            let newRPM = (theta / 360) * 10;
            if (currentRPM > 8.0 && newRPM < 2.0) newRPM = 10.0;
            else if (currentRPM < 2.0 && newRPM > 8.0) newRPM = 0.0;
            if (newRPM >= 9.8) newRPM = 10.0;
            if (newRPM <= 0.2) newRPM = 0.0;

            updateDialUI(newRPM, true);
        };

        dial.addEventListener('mousedown', () => isDragging = true); window.addEventListener('mouseup', () => isDragging = false); window.addEventListener('mousemove', onMove);
        dial.addEventListener('touchstart', () => isDragging = true, {passive:false}); window.addEventListener('touchend', () => isDragging = false); window.addEventListener('touchmove', onMove, {passive:false});
        
        window.addEventListener('resetDials', () => updateDialUI(0, false)); 
        updateDialUI(0, false);
    }
    setupMotor('A'); setupMotor('B');

    // --- CEREBRO DE SINCRONIZACIÓN (El Servidor Manda) ---
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
                    
                    // Sincronizar botones de Poder y Arranque con el estado REAL del PLC
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
                    
                    // Actualizar el cartel de permisos basado en lo que dice Python
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
    };
});