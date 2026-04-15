@echo off
title BioX Core System Launcher
color 0B

echo ===================================================
echo   INICIALIZANDO SISTEMA CLINOESTATO - BIOX LAB
echo ===================================================
echo.
echo [1/2] Levantando puente de comunicacion PLC (FastAPI)...
start /MIN cmd /k "main.py"

echo Esperando estabilizacion del servidor...
timeout /t 3 /nobreak > NUL

echo [2/2] Abriendo Interfaz de Control Bio-Digital...
start index.html

echo.
echo Sistema desplegado con exito.
echo Esta ventana se cerrara en 3 segundos...
timeout /t 3 > NUL
exit