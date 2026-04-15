document.addEventListener('DOMContentLoaded', () => {
    const loader = document.getElementById('loader');
    const main = document.getElementById('main-content');
    
    // Estados Globales
    let isPwrOn = false;
    let isRunOn = false;

    // Splash Screen
    window.addEventListener('load', () => {
        setTimeout(() => {
            loader.style.opacity = '0';
            setTimeout(() => {
                loader.style.display = 'none';
                main.style.display = 'block';
            }, 800);
        }, 3000);
    });

    // --- FUNCIONES DE MANDO ---
    window.togglePower = async () => {
        isPwrOn = !isPwrOn;
        const btn = document.getElementById('pwrBtn');
        
        btn.style.background = isPwrOn ? 'var(--neon-green)' : 'transparent';
        btn.style.color = isPwrOn ? 'black' : 'var(--neon-green)';
        btn.innerText = isPwrOn ? "SYSTEM POWER: ON" : "SYSTEM POWER: OFF";

        if (!isPwrOn && isRunOn) {
            isRunOn = false;
            const btnStart = document.getElementById('strBtn');
            btnStart.style.background = 'transparent';
            btnStart.style.color = 'var(--neon-cyan)';
            btnStart.innerText = "START ENGINE";
        }

        try {
            await fetch(`http://127.0.0.1:8000/motor/power/${isPwrOn}`, { method: 'POST' });
        } catch (e) { console.error("PLC Link Failure"); }
    };

    // MODIFICADO: Ahora inyecta la velocidad al arrancar para que el PLC reaccione
    window.toggleStart = async () => {
        if(!isPwrOn) {
            alert("⚠️ SECURITY PROTOCOL: Engaging Power required first.");
            return;
        }
        isRunOn = !isRunOn;
        const btn = document.getElementById('strBtn');
        
        btn.style.background = isRunOn ? 'var(--neon-cyan)' : 'transparent';
        btn.style.color = isRunOn ? 'black' : 'var(--neon-cyan)';
        btn.innerText = isRunOn ? "ENGINE: RUNNING" : "START ENGINE";

        try {
            // 1. Mandar señal de arranque
            await fetch(`http://127.0.0.1:8000/motor/start/${isRunOn}`, { method: 'POST' });

            // 2. INYECCIÓN: Si encendemos, mandamos los valores actuales de los sliders de inmediato
            if (isRunOn) {
                const valA = document.getElementById('sliderA').value;
                const valB = document.getElementById('sliderB').value;
                await sendToPLC('A', valA);
                await sendToPLC('B', valB);
            }
        } catch (e) { console.error("PLC Link Failure"); }
    };

    // --- CONTROL DE MOTORES ---
    async function sendToPLC(motor, value) {
        try {
            await fetch(`http://127.0.0.1:8000/control/${motor}/${value}`, { method: 'POST' });
        } catch (e) { console.error("Data Link Failure"); }
    }

    function updateMotorUI(id, val) {
        const slider = document.getElementById('slider' + id);
        const num = document.getElementById('num' + id);
        const display = document.getElementById('val' + id);
        const v = parseFloat(val).toFixed(1);
        
        slider.value = v;
        num.value = v;
        display.innerHTML = `${v}<span>RPM</span>`;
        return v;
    }

    function setupMotor(id) {
        const slider = document.getElementById('slider' + id);
        const num = document.getElementById('num' + id);
        let timeoutId;

        slider.oninput = (e) => {
            const v = updateMotorUI(id, e.target.value);
            clearTimeout(timeoutId);
            timeoutId = setTimeout(() => sendToPLC(id, v), 200);
        };

        num.onchange = (e) => {
            const v = updateMotorUI(id, e.target.value);
            sendToPLC(id, v);
        };
    }

    setupMotor('A');
    setupMotor('B');

    // --- GRÁFICA DE VIBRACIÓN ---
    const ctx = document.getElementById('vibrationChart').getContext('2d');
    const chart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: Array(20).fill(''),
            datasets: [{
                data: Array(20).fill(0),
                borderColor: '#ff003c',
                borderWidth: 2,
                tension: 0.4,
                pointRadius: 0,
                fill: true,
                backgroundColor: 'rgba(255, 0, 60, 0.1)'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: { y: { display: false, min: 0, max: 1 }, x: { display: false } },
            plugins: { legend: { display: false } }
        }
    });

    // --- LOOP DE TELEMETRÍA ---
    const liveIndicator = document.querySelector('.live-indicator');
    
    setInterval(async () => {
        try {
            const res = await fetch('http://127.0.0.1:8000/telemetria');
            if (res.ok) {
                liveIndicator.style.border = '1px solid var(--neon-green)';
                liveIndicator.style.color = 'var(--neon-green)';
                liveIndicator.innerHTML = '<span class="pulse-dot"></span> LIVE TELEMETRY';
            }
            document.getElementById('tempVal').innerText = (24 + Math.random()).toFixed(1);

            if (isRunOn) {
                chart.data.datasets[0].data.shift();
                chart.data.datasets[0].data.push(0.2 + Math.random() * 0.4);
                chart.update('none');
            }
        } catch (e) {
            liveIndicator.style.border = '1px solid var(--neon-red)';
            liveIndicator.style.color = 'var(--neon-red)';
            liveIndicator.innerHTML = '⚠️ OFFLINE';
        }
    }, 500);

    // --- BOTÓN DE PÁNICO ---
    document.getElementById('panicButton').onclick = async () => {
        isRunOn = false;
        isPwrOn = false;
        
        const btnStart = document.getElementById('strBtn');
        btnStart.style.background = 'transparent';
        btnStart.style.color = 'var(--neon-cyan)';
        btnStart.innerText = "START ENGINE";
        
        const btnPwr = document.getElementById('pwrBtn');
        btnPwr.style.background = 'transparent';
        btnPwr.style.color = 'var(--neon-green)';
        btnPwr.innerText = "SYSTEM POWER: OFF";

        const emergencyValue = 1.0;
        updateMotorUI('A', emergencyValue);
        updateMotorUI('B', emergencyValue);

        sendToPLC('A', emergencyValue);
        sendToPLC('B', emergencyValue);
        
        try {
            await fetch('http://127.0.0.1:8000/emergency', { method: 'POST' });
            alert('🚨 CRITICAL HALT: V90 & S210 TERMINATED. SPEEDS RESET TO 1.0 RPM.');
        } catch (e) {
            alert('⚠️ EMERGENCY HALT FAILED: NO CONNECTION TO CORE.');
        }
    };
});