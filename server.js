require('dotenv').config();
const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors({ origin: '*', credentials: false }));
app.use(express.json());

app.use('/api/auth',      require('./routes/auth'));
app.use('/api/muebles',   require('./routes/muebles'));
app.use('/api/reservas',  require('./routes/reservas'));
app.use('/api/categorias',require('./routes/categorias'));
app.use('/api/admin',     require('./routes/admin'));
app.use('/api/pagos',           require('./routes/pagos'));
app.use('/api/combos',          require('./routes/combos'));
app.use('/api/configuracion',   require('./routes/configuracion'));
app.use('/api/google-calendar', require('./routes/googleCalendar'));

app.get('/api/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 4000;
const db = require('./db');

db.query(`
  CREATE TABLE IF NOT EXISTS configuracion (
    clave VARCHAR(255) PRIMARY KEY,
    valor TEXT
  );
  ALTER TABLE reservas ADD COLUMN IF NOT EXISTS google_event_id VARCHAR(255);
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
  app.listen(PORT, '0.0.0.0', () => console.log(`Servidor corriendo en puerto ${PORT}`));
}).catch(err => {
  console.error('Error al inicializar la base de datos:', err);
  app.listen(PORT, '0.0.0.0', () => console.log(`Servidor corriendo en puerto ${PORT}`));
});
