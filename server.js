require('dotenv').config();
const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors({ origin: '*', credentials: false }));
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ limit: '25mb', extended: true }));

const reservasRouter = require('./routes/reservas');

app.use('/api/auth',      require('./routes/auth'));
app.use('/api/muebles',   require('./routes/muebles'));
app.use('/api/reservas',  reservasRouter);
app.use('/api/categorias',require('./routes/categorias'));
app.use('/api/admin',     require('./routes/admin'));
app.use('/api/pagos',           require('./routes/pagos'));
app.use('/api/combos',          require('./routes/combos'));
app.use('/api/configuracion',   require('./routes/configuracion'));
app.use('/api/google-calendar', require('./routes/googleCalendar'));
app.use('/api/clientes',        require('./routes/clientes'));

app.get('/api/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 4000;
const db = require('./db');

db.query(`
  CREATE TABLE IF NOT EXISTS configuracion (
    clave VARCHAR(255) PRIMARY KEY,
    valor TEXT
  );
  ALTER TABLE reservas ADD COLUMN IF NOT EXISTS google_event_id VARCHAR(255);
  CREATE TABLE IF NOT EXISTS clientes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alias VARCHAR(255),
    nombre VARCHAR(255) NOT NULL,
    cedula VARCHAR(100),
    telefono VARCHAR(100),
    email VARCHAR(255),
    direccion TEXT,
    notas TEXT,
    creado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    actualizado_en TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  ALTER TABLE reservas ADD COLUMN IF NOT EXISTS cliente_id UUID REFERENCES clientes(id) ON DELETE SET NULL;
  ALTER TABLE clientes ADD COLUMN IF NOT EXISTS contacto2_nombre VARCHAR(255);
  ALTER TABLE clientes ADD COLUMN IF NOT EXISTS contacto2_telefono VARCHAR(100);
  CREATE TABLE IF NOT EXISTS reserva_combo_items (
    id SERIAL PRIMARY KEY,
    reserva_id UUID REFERENCES reservas(id) ON DELETE CASCADE,
    combo_id UUID REFERENCES combos(id) ON DELETE CASCADE,
    mueble_id UUID REFERENCES muebles(id) ON DELETE CASCADE,
    cantidad INT NOT NULL
  );
  ALTER TABLE reserva_items DROP CONSTRAINT IF EXISTS reserva_items_mueble_id_fkey;
  ALTER TABLE reserva_items ADD CONSTRAINT reserva_items_mueble_id_fkey FOREIGN KEY (mueble_id) REFERENCES muebles(id) ON DELETE SET NULL;
`).then(() => {
  console.log('Tablas y columnas verificadas/creadas con éxito');
  if (typeof reservasRouter.autoCompletarReservasExpiradas === 'function') {
    reservasRouter.autoCompletarReservasExpiradas().catch(err => console.error('[Startup] Error auto-completar/saldar:', err.message));
    // Ejecutar periódicamente cada hora para mantener saldadas y actualizadas las reservas vencidas
    setInterval(() => {
      reservasRouter.autoCompletarReservasExpiradas().catch(err => console.error('[Interval] Error auto-completar/saldar:', err.message));
    }, 60 * 60 * 1000);
  }
  app.listen(PORT, '0.0.0.0', () => console.log(`Servidor corriendo en puerto ${PORT}`));
}).catch(err => {
  console.error('Error al inicializar la base de datos:', err);
  app.listen(PORT, '0.0.0.0', () => console.log(`Servidor corriendo en puerto ${PORT}`));
});
