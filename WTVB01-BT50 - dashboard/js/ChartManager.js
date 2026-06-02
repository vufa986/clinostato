export class ChartManager {
    constructor(canvasId, colors) {
        this.maxPoints = 50;
        this.ctx = document.getElementById(canvasId).getContext('2d');
        
        // Crea un relleno degradado semitransparente para darle volumen a las líneas
        const createGradient = (hexColor) => {
            const gradient = this.ctx.createLinearGradient(0, 0, 0, 300);
            gradient.addColorStop(0, hexColor + '26'); // 15% de opacidad
            gradient.addColorStop(1, hexColor + '00'); // Transparente
            return gradient;
        };

        this.chart = new Chart(this.ctx, {
            type: 'line',
            data: {
                labels: Array(this.maxPoints).fill(''),
                datasets: [
                    { label: 'X', borderColor: colors.x, backgroundColor: createGradient(colors.x), fill: true, data: Array(this.maxPoints).fill(0) },
                    { label: 'Y', borderColor: colors.y, backgroundColor: createGradient(colors.y), fill: true, data: Array(this.maxPoints).fill(0) },
                    { label: 'Z', borderColor: colors.z, backgroundColor: createGradient(colors.z), fill: true, data: Array(this.maxPoints).fill(0) }
                ]
            },
            options: {
                responsive: true, maintainAspectRatio: false, animation: false,
                // tension: 0.2 curva ligeramente los vértices para que se vea como onda natural
                elements: { point: { radius: 0, hoverRadius: 5 }, line: { borderWidth: 2, tension: 0.2 } },
                plugins: { 
                    legend: { display: false },
                    // Habilita tooltips al pasar el ratón para ver los valores exactos en un instante dado
                    tooltip: { mode: 'index', intersect: false } 
                },
                interaction: { mode: 'nearest', axis: 'x', intersect: false },
                scales: { 
                    x: { display: false }, 
                    y: { grid: { color: '#27272a' }, ticks: { color: '#a1a1aa' } } 
                }
            }
        });
    }

    update(x, y, z) {
        this.chart.data.datasets[0].data.push(x); this.chart.data.datasets[0].data.shift();
        this.chart.data.datasets[1].data.push(y); this.chart.data.datasets[1].data.shift();
        this.chart.data.datasets[2].data.push(z); this.chart.data.datasets[2].data.shift();
        this.chart.update();
    }
}