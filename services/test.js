import fetch from 'node-fetch'; // O usa la función nativa fetch de Node

async function probarEnvioReal() {
    console.log("🚀 Disparando mensaje de prueba a través del servidor...");

    try {
        // Aquí llamamos a la ruta de tu API que maneja el envío
        const respuesta = await fetch('http://localhost:3001/api/send-sample', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                phone: "573124958163", // Tu número
                message: "¡Hola! Esta es la prueba final desde el microservicio conectado de Nextal Graphic."
            })
        });

        const resultado = await respuesta.json();
        console.log("✅ Respuesta del servidor:", resultado);
    } catch (error) {
        console.error("❌ Error al conectar con el servidor:", error);
    }
}

probarEnvioReal();