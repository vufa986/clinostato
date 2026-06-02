document.addEventListener('DOMContentLoaded', () => {
    let isPwrOn = false, isRunOn = false;
    let autoDirTimers = { A: null, B: null };
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

    const logToConsole = (msg, type = 'INFO') => {
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

    const resetUI = () => {
        ['A', 'B'].forEach(id => {
            document.getElementById(`val${id}-center`).innerText = "0.0";
            document.getElementById(`mv${id}`).value = "0.0";
            document.getElementById(`torque${id}`).value = "0.0";
        });
        ui.liveA.innerHTML = "0.00<span>RPM</span>"; ui.liveB.innerHTML = "0.00<span>RPM</span>";
        liveChart.data.datasets.forEach(ds => ds.data.fill(0)); liveChart.update();
    };

    window.addEventListener('load', () => { setTimeout(() => { ui.loader.style.opacity = '0'; setTimeout(() => { ui.loader.style.display = 'none'; ui.main.style.display = 'block'; logToConsole("System Initialized and ready.", "INFO"); }, 800); }, 2000); });

    window.togglePower = async () => {
        isPwrOn = !isPwrOn;
        document.getElementById('pwrBtn').className = isPwrOn ? 'pwr-on' : ''; 
        document.getElementById('pwrBtn').innerText = isPwrOn ? "SYSTEM POWER: ON" : "SYSTEM POWER: OFF";
        document.getElementById('live-telemetry').className = isPwrOn ? 'live-indicator status-on' : 'live-indicator status-off';
        logToConsole(`System Power set to ${isPwrOn ? 'ON' : 'OFF'}.`, "POWER");
        try { await fetch(`/motor/power/${isPwrOn}`, { method: 'POST' }); } catch(e){}
        if (!isPwrOn) { isRunOn = false; clearInterval(telemetryInterval); resetUI(); window.dispatchEvent(new CustomEvent('resetDials')); }
    };

    window.toggleStart = async () => {
        if(!isPwrOn) return alert("ACTIVATE SYSTEM POWER FIRST");
        isRunOn = !isRunOn;
        document.getElementById('strBtn').className = isRunOn ? 'str-on' : ''; 
        document.getElementById('strBtn').innerText = isRunOn ? "ENGINE: RUNNING" : "START ENGINE";
        logToConsole(isRunOn ? "Engine started. Telemetry active." : "Engine stopped.", "ENGINE");
        try { await fetch(`/motor/start/${isRunOn}`, { method: 'POST' }); } catch(e){}
        if (isRunOn) { startTelemetryPolling(); } else { clearInterval(telemetryInterval); resetUI(); window.dispatchEvent(new CustomEvent('resetDials')); }
    };

    window.updateExtras = async (m) => {
        try { await fetch(`/extra/${m}/${document.getElementById(`dir${m}`).value}/${document.getElementById(`mv${m}`).value}/${document.getElementById(`torque${m}`).value}`, { method: 'POST' }); } catch(e){}
    };

    function setupMotor(id) {
        const dial = document.getElementById(`dial${id === 'A' ? 'X' : 'Y'}Container`).firstElementChild;
        const needle = dial.querySelector('.dial-needle-container');
        const readout = document.getElementById(`val${id}-center`);
        const bgRotator = document.getElementById(`bgRotator${id}`);
        let tAxis, isDragging = false, currentRPM = 0.0;

        setInterval(() => { bgRotator.style.animationDuration = (isPwrOn && isRunOn && currentRPM > 0) ? `${20/currentRPM}s` : '0s'; }, 100);

        const updateDialUI = (rpm) => {
            currentRPM = rpm; 
            readout.innerText = currentRPM.toFixed(1); 
            needle.style.transform = `rotate(${(currentRPM/10)*360}deg)`;
            clearTimeout(tAxis); tAxis = setTimeout(() => fetch(`/control/${id}/${currentRPM.toFixed(1)}`, { method: 'POST' }).catch(()=>{}), 250);
        };

        const onMove = (e) => {
            if (!isDragging) return; e.preventDefault();
            const rect = dial.getBoundingClientRect(), cx = rect.left + rect.width/2, cy = rect.top + rect.height/2;
            let theta = Math.atan2((e.touches?e.touches[0].clientY:e.clientY)-cy, (e.touches?e.touches[0].clientX:e.clientX)-cx)*180/Math.PI + 90;
            if (theta < 0) theta += 360;
            
            let newRPM = (theta / 360) * 10;

            // --- LÓGICA DE BLOQUEO ANTI WRAP-AROUND ---
            if (currentRPM > 8.0 && newRPM < 2.0) {
                newRPM = 10.0; // Bloquea el salto de 10 a 0. Se queda anclado en 10.
            } else if (currentRPM < 2.0 && newRPM > 8.0) {
                newRPM = 0.0;  // Bloquea el salto de 0 a 10 hacia atrás. Se queda anclado en 0.
            }

            // Zonas muertas para garantizar el 0.0 y 10.0 exactos
            if (newRPM >= 9.8) newRPM = 10.0;
            if (newRPM <= 0.2) newRPM = 0.0;

            updateDialUI(newRPM);
        };

        dial.addEventListener('mousedown', () => isDragging = true); window.addEventListener('mouseup', () => isDragging = false); window.addEventListener('mousemove', onMove);
        dial.addEventListener('touchstart', () => isDragging = true, {passive:false}); window.addEventListener('touchend', () => isDragging = false); window.addEventListener('touchmove', onMove, {passive:false});
        window.addEventListener('resetDials', () => updateDialUI(0)); updateDialUI(0);
    }
    setupMotor('A'); setupMotor('B');

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
                }
            } catch (e) {}
        }, 300);
    }

    document.getElementById('panicButton').onclick = async () => {
        try { await fetch('/emergency', { method: 'POST' }); } catch(e){}
        isPwrOn = false; isRunOn = false; clearInterval(telemetryInterval);
        document.getElementById('pwrBtn').className = ''; document.getElementById('strBtn').className = '';
        logToConsole("EMERGENCY ACTIVATED.", "EMERGENCY"); window.dispatchEvent(new CustomEvent('resetDials')); resetUI();
    };
});