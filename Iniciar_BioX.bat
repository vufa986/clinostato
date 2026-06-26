bat_content = """@echo off
title NEXUS TECH - SCADA 2.0 BOOT SEQUENCE
color 0B
echo.
echo ========================================================
echo        NEXUS TECH - ADVANCED BIOMETRIC SYSTEM
echo             INICIANDO SISTEMA SCADA 2.0
echo ========================================================
echo.

:: 1. Verificando Python
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Python no esta instalado o no esta en el PATH.
    pause
    exit
)

:: 2. Activando Entorno Virtual (Recomendado)
if exist venv\\Scripts\\activate.bat (
    echo [SISTEMA] Activando entorno virtual de Python...
    call venv\\Scripts\\activate.bat
)

:: 3. Instalando requerimientos esenciales
echo [SISTEMA] Verificando dependencias (FastAPI, Uvicorn, Snap7, Bleak, Requests)...
if exist requirements.txt (
    pip install -r requirements.txt >nul 2>&1
) else (
    pip install fastapi uvicorn python-snap7 bleak requests >nul 2>&1
)

echo.
echo [SISTEMA] Arrancando Servicios de Microarquitectura...

:: 4. Levantando tunel ngrok en ventana independiente
echo [SISTEMA] Iniciando tunel seguro con Ngrok (Puerto 8000)...
start "Ngrok Tunnel" cmd /k "ngrok http 8000"

:: 5. Driver BLE Externo (Desactivado)
:: Esta linea esta comentada porque main.py ya maneja el Bluetooth internamente.
:: Esto evita bloqueos y hardware "congelado".
:: start "Driver BLE - WTVB01" cmd /k "python driver_wtvb01.py"

echo.
echo ========================================================
echo        DEJA ESTA VENTANA ABIERTA PARA MANTENER 
echo          EL SERVIDOR WEB Y PLC COMUNICADOS
echo ========================================================
echo.

:: 6. Abre Chrome automaticamente en la interfaz del Clinostato
echo [SISTEMA] Abriendo Panel de Control Maestro (Clinostato)...
start http://127.0.0.1:8000/

:: 7. Ejecuta el backend principal
python main.py
pause
"""

with open("Iniciar_BioX.bat", "w") as f:
    f.write(bat_content)
print("Archivo Iniciar_BioX.bat generado exitosamente.")