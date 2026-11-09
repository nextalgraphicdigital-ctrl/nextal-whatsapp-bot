import fetch from 'node-fetch';

async function test() {
    try {
        console.log('Probando conexion a Supabase...');
        const res = await fetch('https://ygpfwmevizoetnvsxsqu.supabase.co/rest/v1/', {
            headers: { 'apikey': 'sb_secret_k0ddE0F879UU41GpNcnhQ_CxbHul1f' }
        });
        console.log('Respuesta:', res.status);
    } catch (err) {
        console.error('Error detallado de red:', err);
    }
}

test();