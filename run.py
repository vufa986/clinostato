import subprocess
import sys
import os
import time

def verificar_dependencias():
    print("[SISTEMA] Verificando integridad de las dependencias (requirements.txt)...")
    if not os.path.exists("requirements.txt"):
        print("[ADVERTENCIA] Archivo requirements.txt no encontrado. Omitiendo verificación.")
        return

    try:
        # Ejecuta pip install en modo silencioso (-q). Si ya están instaladas, es casi instantáneo.
        subprocess.check_call(
            [sys.executable, "-m", "pip", "install", "-q", "-r", "requirements.txt"]
        )
        print("[SISTEMA] Módulos de Python verificados correctamente.")
    except subprocess.CalledProcessError as e:
        print(f"[ERROR CRÍTICO] Falló la instalación de dependencias. Revisa tu conexión a internet o permisos. Detalle: {e}")
        sys.exit(1)

def iniciar_plataforma():
    os.system('cls' if os.name == 'nt' else 'clear')
    print("========================================================")
    print("       NEXUS TECH - ADVANCED BIOMETRIC SYSTEM")
    print("            INICIANDO MOTOR SCADA DE PRODUCCIÓN")
    print("========================================================")

    # 1. Autogestión de dependencias
    verificar_dependencias()
    
    # 2. Iniciar Ngrok de fondo de manera silenciosa
    print("[SISTEMA] Estableciendo túnel de comunicaciones seguro (Ngrok)...")
    with open(os.devnull, 'w') as fnull:
        # Se asume que ngrok está en las variables de entorno (PATH)
        subprocess.Popen("ngrok http 8000", shell=True, stdout=fnull, stderr=fnull)
    
    time.sleep(2) # Dar tiempo a que el túnel consolide la conexión

    # 3. Lanzar el navegador automáticamente al Panel Maestro
    print("[SISTEMA] Abriendo Panel de Control Maestro en el navegador...")
    subprocess.Popen("start http://127.0.0.1:8000/", shell=True)

    # 4. Ejecutar el Servidor Web (main.py)
    print("[SISTEMA] Entregando control al núcleo Uvicorn/FastAPI...")
    try:
        import uvicorn
        # Llama a tu archivo 'main.py' y su objeto 'app'
        uvicorn.run("main:app", host="0.0.0.0", port=8000, log_level="warning")
    except KeyboardInterrupt:
        print("\n[SISTEMA] Apagando suite SCADA de forma segura. ¡Hasta pronto!")
    except Exception as e:
        print(f"\n[ERROR] El servidor finalizó de forma inesperada: {e}")

if __name__ == "__main__":
    # Asegura que la ejecución actualice su directorio de trabajo a donde está el script
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    iniciar_plataforma()