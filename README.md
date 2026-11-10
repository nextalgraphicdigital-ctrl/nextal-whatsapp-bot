# Nextal WhatsApp Bot

Automatización local de WhatsApp para Nextal Graphic, preparada para WhatsApp Cloud API oficial de Meta.

## Instalación en otro PC

1. Instala Node.js 20 LTS y Git.
2. Clona este repositorio.
3. Copia `.env.example` como `.env` y completa las variables con las credenciales privadas del negocio.
4. En Meta Developers configura la URL pública `https://TU-DOMINIO/webhooks/whatsapp` y usa el mismo valor privado para `WHATSAPP_WEBHOOK_VERIFY_TOKEN`.
5. Completa `WHATSAPP_CLOUD_TOKEN` y `WHATSAPP_PHONE_NUMBER_ID` en `.env`.
6. Ejecuta `npm install` y después `npm start`.

No subas `.env`, `baileys_auth_info` ni `logs` al repositorio. La API oficial no requiere QR ni dispositivos vinculados.

Solo debe haber una instancia del bot encendida a la vez para evitar mensajes duplicados.
