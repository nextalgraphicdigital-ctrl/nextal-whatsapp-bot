# Nextal WhatsApp Bot

Automatización local de WhatsApp para Nextal Graphic.

## Instalación en otro PC

1. Instala Node.js 20 LTS y Git.
2. Clona este repositorio.
3. Copia `.env.example` como `.env` y completa las variables con las credenciales privadas del negocio.
4. Ejecuta `npm install` y después `npm start`.
5. Escanea el QR desde el teléfono del WhatsApp de Nextal, en **Dispositivos vinculados**.

No subas `.env`, `baileys_auth_info` ni `logs` al repositorio.

Solo debe haber una instancia del bot encendida a la vez para evitar mensajes duplicados.
