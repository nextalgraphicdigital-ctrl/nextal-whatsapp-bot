const useCloudApi = () => String(process.env.WHATSAPP_TRANSPORT || 'baileys').toLowerCase() === 'cloud';

async function currentTransport() {
  return useCloudApi()
    ? import('./whatsappCloudService.js')
    : import('./baileysService.js');
}

export async function sendWhatsappWithDelay(...args) {
  const transport = await currentTransport();
  return transport.sendWhatsappWithDelay(...args);
}

export const sendWhatsAppWithDelay = sendWhatsappWithDelay;
export { sendWhatsappWithDelay as sendWhatsApp };

export const isCloudApiTransport = useCloudApi;
