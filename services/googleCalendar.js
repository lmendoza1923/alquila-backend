const db = require('../db');

// Ayudante para obtener configuración desde la BD o variables de entorno
async function getGoogleConfig() {
  const res = await db.query(
    "SELECT clave, valor FROM configuracion WHERE clave IN ('google_client_id', 'google_client_secret', 'google_redirect_uri', 'google_calendar_tokens', 'google_calendar_email', 'google_calendar_auto_sync')"
  );
  const cfg = {};
  res.rows.forEach(r => { cfg[r.clave] = r.valor; });

  const clientId = cfg.google_client_id || process.env.GOOGLE_CLIENT_ID || '';
  const clientSecret = cfg.google_client_secret || process.env.GOOGLE_CLIENT_SECRET || '';
  const redirectUri = cfg.google_redirect_uri || process.env.GOOGLE_REDIRECT_URI || 'http://localhost:4000/api/google-calendar/callback';
  
  let tokens = null;
  if (cfg.google_calendar_tokens) {
    try {
      tokens = JSON.parse(cfg.google_calendar_tokens);
    } catch (e) {
      tokens = null;
    }
  }

  return {
    clientId,
    clientSecret,
    redirectUri,
    tokens,
    email: cfg.google_calendar_email || null,
    autoSync: cfg.google_calendar_auto_sync !== 'false'
  };
}

// Guardar valor en la tabla configuracion
async function saveConfigKey(clave, valor) {
  await db.query(
    `INSERT INTO configuracion (clave, valor) VALUES ($1, $2)
     ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor`,
    [clave, valor]
  );
}

// Generar URL de autorización de Google OAuth2
async function getAuthUrl(customRedirectUri) {
  const config = await getGoogleConfig();
  if (!config.clientId) {
    throw new Error('Debes configurar el Google Client ID en las opciones o en el archivo .env');
  }

  const redirectUri = customRedirectUri || config.redirectUri;
  const scopes = [
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/userinfo.email'
  ].join(' ');

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true'
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

// Intercambiar código de autorización por tokens
async function handleCallback(code, customRedirectUri) {
  const config = await getGoogleConfig();
  const redirectUri = customRedirectUri || config.redirectUri;

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    })
  });

  const data = await response.json();
  if (!response.ok || data.error) {
    throw new Error(data.error_description || data.error || 'Error al canjear el código de autorización con Google');
  }

  const tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || (config.tokens?.refresh_token ?? null),
    expiry_date: Date.now() + (data.expires_in * 1000),
    token_type: data.token_type
  };

  // Obtener el correo del usuario autenticado
  let userEmail = null;
  try {
    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    if (userRes.ok) {
      const userData = await userRes.json();
      userEmail = userData.email;
    }
  } catch (err) {
    console.error('Error al obtener perfil de Google:', err.message);
  }

  await saveConfigKey('google_calendar_tokens', JSON.stringify(tokens));
  if (userEmail) {
    await saveConfigKey('google_calendar_email', userEmail);
  }

  return { email: userEmail, tokens };
}

// Obtener un token de acceso válido (renovando si es necesario)
async function getValidAccessToken() {
  const config = await getGoogleConfig();
  if (!config.tokens || (!config.tokens.access_token && !config.tokens.refresh_token)) {
    return null;
  }

  const { tokens, clientId, clientSecret } = config;

  // Si el token aún es válido (con margen de 3 minutos), reutilizarlo
  if (tokens.access_token && tokens.expiry_date && tokens.expiry_date > Date.now() + (3 * 60 * 1000)) {
    return tokens.access_token;
  }

  // Renovar token usando refresh_token
  if (!tokens.refresh_token) {
    console.warn('Google Calendar: access_token expirado y no hay refresh_token disponible.');
    return null;
  }

  try {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: tokens.refresh_token,
        grant_type: 'refresh_token'
      })
    });

    const data = await response.json();
    if (!response.ok || data.error) {
      console.error('Error al refrescar token de Google:', data);
      return null;
    }

    const newTokens = {
      ...tokens,
      access_token: data.access_token,
      expiry_date: Date.now() + (data.expires_in * 1000)
    };
    if (data.refresh_token) {
      newTokens.refresh_token = data.refresh_token;
    }

    await saveConfigKey('google_calendar_tokens', JSON.stringify(newTokens));
    return newTokens.access_token;
  } catch (err) {
    console.error('Error de conexión al refrescar token de Google:', err.message);
    return null;
  }
}

// Ayudante: fecha final exclusiva (+1 día) para eventos de día completo en Google Calendar
function getExclusiveEndDate(dateStr) {
  if (!dateStr) return dateStr;
  const parts = dateStr.substring(0, 10).split('-');
  if (parts.length !== 3) return dateStr;
  const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  d.setDate(d.getDate() + 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Construir payload de evento para Google Calendar
function buildEventBody(reserva, items = []) {
  const cleanPhone = (reserva.telefono_cliente || '').replace(/^\+?507\s*/, '').trim();
  const idCorto = (reserva.id || '').toString().slice(0, 8).toUpperCase();
  const nombreCliente = reserva.nombre_cliente || 'Cliente';
  const alias = reserva.alias_cliente ? ` (${reserva.alias_cliente})` : '';

  const summary = `🎉 Reserva: ${nombreCliente}${alias} #${idCorto}`;

  const itemsTexto = (items && items.length > 0)
    ? items.map(i => `• ${i.cantidad}x ${i.nombre || i.mueble || 'Artículo'}`).join('\n')
    : '• Mobiliario contratado';

  const description = `📋 DETALLES DE LA RESERVA #${idCorto}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 Cliente: ${nombreCliente}
🏷️ Evento: ${reserva.alias_cliente || 'N/A'}
📞 Teléfono: ${cleanPhone || 'N/A'}
✉️ Email: ${reserva.email_cliente || 'N/A'}
📍 Dirección de Entrega: ${reserva.direccion_entrega || 'N/A'}
📝 Notas / Instrucciones: ${reserva.notas || reserva.notes || 'Ninguna'}
💰 Total Contratado: $${parseFloat(reserva.total || 0).toFixed(2)}
📊 Estado: ${reserva.estado || 'activa'}

📦 ARTÍCULOS Y MOBILIARIO:
${itemsTexto}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✨ Sistema de Alquiler de Mobiliario`;

  const startStr = (reserva.fecha_inicio || '').substring(0, 10);
  const endStr = (reserva.fecha_fin || reserva.fecha_inicio || '').substring(0, 10);

  return {
    summary,
    description,
    location: reserva.direccion_entrega || '',
    start: { date: startStr },
    end: { date: getExclusiveEndDate(endStr) }
  };
}

// Crear un evento en Google Calendar
async function crearEventoReserva(reserva, items = []) {
  try {
    const accessToken = await getValidAccessToken();
    if (!accessToken) return null;

    const eventBody = buildEventBody(reserva, items);

    const response = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(eventBody)
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      console.error('Error al crear evento en Google Calendar:', errData);
      return null;
    }

    const event = await response.json();
    console.log(`[Google Calendar] Evento creado con ID: ${event.id} para reserva ${reserva.id}`);
    
    // Guardar el google_event_id en la base de datos
    if (event.id && reserva.id) {
      await db.query('UPDATE reservas SET google_event_id = $1 WHERE id = $2', [event.id, reserva.id]);
    }

    return event.id;
  } catch (err) {
    console.error('Error inesperado en crearEventoReserva:', err.message);
    return null;
  }
}

// Actualizar un evento existente en Google Calendar
async function actualizarEventoReserva(googleEventId, reserva, items = []) {
  if (!googleEventId) {
    return crearEventoReserva(reserva, items);
  }

  try {
    const accessToken = await getValidAccessToken();
    if (!accessToken) return null;

    const eventBody = buildEventBody(reserva, items);

    const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(googleEventId)}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(eventBody)
    });

    if (response.status === 404) {
      // Si fue eliminado en Google Calendar, crear uno nuevo
      return crearEventoReserva(reserva, items);
    }

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      console.error('Error al actualizar evento en Google Calendar:', errData);
      return null;
    }

    const event = await response.json();
    console.log(`[Google Calendar] Evento actualizado: ${event.id}`);
    return event.id;
  } catch (err) {
    console.error('Error inesperado en actualizarEventoReserva:', err.message);
    return null;
  }
}

// Eliminar un evento en Google Calendar
async function eliminarEventoReserva(googleEventId) {
  if (!googleEventId) return false;

  try {
    const accessToken = await getValidAccessToken();
    if (!accessToken) return false;

    const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(googleEventId)}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });

    if (response.ok || response.status === 404 || response.status === 410) {
      console.log(`[Google Calendar] Evento eliminado: ${googleEventId}`);
      return true;
    }

    return false;
  } catch (err) {
    console.error('Error al eliminar evento en Google Calendar:', err.message);
    return false;
  }
}

// Sincronizar todas las reservas activas/existentes
async function sincronizarTodasLasReservas() {
  const accessToken = await getValidAccessToken();
  if (!accessToken) {
    throw new Error('Google Calendar no está conectado');
  }

  // Traer reservas que no estén canceladas
  const res = await db.query(`
    SELECT r.*, 
      (SELECT json_agg(json_build_object(
        'nombre', ri.nombre,
        'cantidad', ri.cantidad,
        'precio_unitario', ri.precio_unitario,
        'subtotal', ri.subtotal
      )) FROM reserva_items ri WHERE ri.reserva_id = r.id) as items
    FROM reservas r
    WHERE r.estado != 'cancelada'
    ORDER BY r.fecha_inicio DESC
  `);

  let creados = 0;
  let actualizados = 0;

  for (const reserva of res.rows) {
    const items = reserva.items || [];
    if (reserva.google_event_id) {
      const eventId = await actualizarEventoReserva(reserva.google_event_id, reserva, items);
      if (eventId) actualizados++;
    } else {
      const eventId = await crearEventoReserva(reserva, items);
      if (eventId) creados++;
    }
  }

  return { total: res.rows.length, creados, actualizados };
}

// Desconectar Google Calendar
async function disconnectCalendar() {
  await db.query("DELETE FROM configuracion WHERE clave IN ('google_calendar_tokens', 'google_calendar_email')");
  return true;
}

// Obtener estado actual
async function getCalendarStatus() {
  const config = await getGoogleConfig();
  const hasClientId = Boolean(config.clientId);
  const isConnected = Boolean(config.tokens?.access_token || config.tokens?.refresh_token);

  return {
    configured: hasClientId,
    connected: isConnected,
    email: config.email,
    clientId: config.clientId ? `${config.clientId.slice(0, 12)}...` : '',
    autoSync: config.autoSync
  };
}

module.exports = {
  getGoogleConfig,
  saveConfigKey,
  getAuthUrl,
  handleCallback,
  getValidAccessToken,
  crearEventoReserva,
  actualizarEventoReserva,
  eliminarEventoReserva,
  sincronizarTodasLasReservas,
  disconnectCalendar,
  getCalendarStatus
};
