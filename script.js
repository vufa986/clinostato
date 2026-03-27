// Asegurar que el DOM esté cargado
document.addEventListener('DOMContentLoaded', () => {
    
    // --- 1. GESTIÓN DE PANTALLA DE CARGA (PRO) ---
    const loader = document.getElementById('loader');
    const mainContent = document.getElementById('main-content');

    // Esperar a que todo cargue (imágenes, librería Chart, etc.)
    window.addEventListener('load', () => {
        setTimeout(() => {
            if(loader) loader.style.opacity = '0';
            setTimeout(() => {
                if(loader) loader.style.display = 'none';
                if(mainContent) mainContent.style.display = 'block';
            }, 500); // Duración de la transición
        }, 3000); // 3 segundos de carga simulada para impacto visual
    });

    // --- 2. SINCRONIZACIÓN DE IMPUTS MOTOR (UX MEJORADA) ---
    function setupMotorSync(id) {
        const slider = document.getElementById('slider' + id);
        const num = document.getElementById('num' + id);
        const display = document.getElementById('val' + id);
        
        // Función única de actualización
        const update = (newVal, source) => { 
            // Validar rango 1-10
            if (newVal < 1) newVal = 1;
            if (newVal > 10) newVal = 10;
            
            // Redondear a un decimal
            const formattedVal = parseFloat(newVal).toFixed(1);
            
            // Actualizar ambos inputs solo si no son la fuente del cambio
            if (source !== 'slider') slider.value = formattedVal;
            if (source !== 'number') num.value = formattedVal;
            
            // Actualizar display grande
            display.innerText = formattedVal + " RPM"; 
        };

        // Eventos nativos de JS
        slider.oninput = (e) => update(e.target.value, 'slider');
        num.onchange = (e) => update(e.target.value, 'number'); // onchange para esperar a que termine de escribir
    }

    // Inicializar motores A y B
    setupMotorSync('A');
    setupMotorSync('B');

    // --- 3. CONFIGURACIÓN GRÁFICA DE VIBRACIÓN (CHART.JS PRO) ---
    const canvas = document.getElementById('vibrationChart');
    if (canvas) {
        const ctx = canvas.getContext('2d');
        
        // Gradiente para efecto visual científico
        const gradient = ctx.createLinearGradient(0, 0, 0, 200);
        gradient.addColorStop(0, 'rgba(255, 56, 96, 0.4)');
        gradient.addColorStop(1, 'rgba(255, 255, 255, 0.05)');

        const chart = new Chart(ctx, {
            type: 'line',
            data: { 
                labels: Array(25).fill(''), 
                datasets: [{ 
                    label: 'Vibración (G)',
                    data: Array(25).fill(0), 
                    borderColor: '#ff3860', 
                    borderWidth: 2,
                    pointRadius: 0, // Sin puntos para que sea más limpia
                    fill: true, 
                    backgroundColor: gradient, // Gradiente aplicado
                    tension: 0.4 // Línea suave (Bézier)
                }] 
            },
            options: { 
                responsive: true,
                maintainAspectRatio: false,
                scales: { 
                    y: { 
                        min: 0, max: 0.1,
                        ticks: { color: '#7a7a7a', font: { size: 11 } },
                        grid: { color: 'rgba(0,0,0,0.03)' }
                    },
                    x: { grid: { display: false } }
                },
                animation: false, // Desactivar animación de Chart.js para WebSockets (velocidad)
                plugins: { legend: { display: false } } 
            }
        });

        // --- 4. SIMULACIÓN DE TELEMETRÍA (Lo que el Backend "llenará") ---
        setInterval(() => {
            // Generar dato aleatorio creíble (0.01 - 0.08G)
            const newVal = Math.random() * 0.07 + 0.01;
            
            // Mover la gráfica (shift + push)
            chart.data.datasets[0].data.shift();
            chart.data.datasets[0].data.push(newVal);
            chart.update(); // Actualización rápida
            
            // Simulación Temperatura (oscila cerca de 24.5)
            const tempValDisplay = document.getElementById('tempVal');
            if(tempValDisplay) {
                const temp = (24 + Math.random()).toFixed(1);
                tempValDisplay.innerText = temp;
            }
        }, 500); // 500ms de refresco
    }

    // --- 5. BOTÓN DE PÁNICO Y ESTADO PLC ---
    const panicBtn = document.getElementById('panicButton');
    if (panicBtn) {
        panicBtn.onclick = () => {
            // Aquí enviarías la orden al PLC por backend
            alert('PARO DE EMERGENCIA ACTIVADO. MOTORES DETENIDOS.');
            // Puedes cambiar visualmente el estado del PLC aquí si la conexión cae
            document.getElementById('plcText').innerText = 'PLC DESCONECTADO';
            document.querySelector('.dot').style.backgroundColor = '#ff3860'; // Cambiar a rojo
        };
    }
});