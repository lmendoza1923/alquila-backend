const router = require('express').Router();
const { auth, admin } = require('../middleware/auth');
const googleCalendar = require('../services/googleCalendar');

// 1. Obtener URL de inicio de sesión de Google Calendar
router.get('/auth-url', auth, admin, async (req, res) => {
  try {
    // Si viene un redirect_uri custom por query o header
    const host = req.get('host');
    const protocol = req.protocol === 'https' || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
    const defaultCallback = `${protocol}://${host}/api/google-calendar/callback`;
    const redirectUri = req.query.redirect_uri || process.env.GOOGLE_REDIRECT_URI || defaultCallback;

    const url = await googleCalendar.getAuthUrl(redirectUri);
    res.json({ url });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 2. Callback de Google OAuth2 (Google redirige aquí tras conceder permisos)
router.get('/callback', async (req, res) => {
  const { code, error } = req.query;
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

  if (error) {
    console.error('Error en callback de Google:', error);
    return res.redirect(`${frontendUrl}/admin?tab=configuracion&google_auth=error&msg=${encodeURIComponent(error)}`);
  }

  if (!code) {
    return res.redirect(`${frontendUrl}/admin?tab=configuracion&google_auth=error&msg=Falta_codigo_de_autorizacion`);
  }

  try {
    const host = req.get('host');
    const protocol = req.protocol === 'https' || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
    const defaultCallback = `${protocol}://${host}/api/google-calendar/callback`;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI || defaultCallback;

    const result = await googleCalendar.handleCallback(code, redirectUri);
    
    // Si la sincronización automática está habilitada, sincronizar reservas de inmediato
    googleCalendar.sincronizarTodasLasReservas().catch(e => {
      console.warn('Sincronización inicial en segundo plano falló:', e.message);
    });

    res.redirect(`${frontendUrl}/admin?tab=configuracion&google_auth=success&email=${encodeURIComponent(result.email || '')}`);
  } catch (err) {
    console.error('Error al procesar callback de Google:', err);
    res.redirect(`${frontendUrl}/admin?tab=configuracion&google_auth=error&msg=${encodeURIComponent(err.message)}`);
  }
});

// 3. Consultar estado de la conexión con Google Calendar
router.get('/status', auth, admin, async (req, res) => {
  try {
    const status = await googleCalendar.getCalendarStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: 'Error al consultar estado de Google Calendar' });
  }
});

// 4. Sincronizar todas las reservas activas/existentes
router.post('/sync-all', auth, admin, async (req, res) => {
  try {
    const resultado = await googleCalendar.sincronizarTodasLasReservas();
    res.json({
      ok: true,
      mensaje: `Sincronización completada con éxito. Total: ${resultado.total}, Nuevos: ${resultado.creados}, Actualizados: ${resultado.actualizados}`,
      ...resultado
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 5. Desconectar cuenta de Google Calendar
router.post('/disconnect', auth, admin, async (req, res) => {
  try {
    await googleCalendar.disconnectCalendar();
    res.json({ ok: true, mensaje: 'Google Calendar desconectado exitosamente' });
  } catch (err) {
    res.status(500).json({ error: 'Error al desconectar Google Calendar' });
  }
});

// 6. Configurar credenciales OAuth de Google (Client ID y Client Secret)
router.post('/credentials', auth, admin, async (req, res) => {
  const { clientId, clientSecret, autoSync } = req.body;
  try {
    if (clientId !== undefined) {
      await googleCalendar.saveConfigKey('google_client_id', (clientId || '').trim());
    }
    if (clientSecret !== undefined) {
      await googleCalendar.saveConfigKey('google_client_secret', (clientSecret || '').trim());
    }
    if (autoSync !== undefined) {
      await googleCalendar.saveConfigKey('google_calendar_auto_sync', autoSync ? 'true' : 'false');
    }
    res.json({ ok: true, mensaje: 'Credenciales de Google guardadas exitosamente' });
  } catch (err) {
    res.status(500).json({ error: 'Error al guardar credenciales' });
  }
});

module.exports = router;
