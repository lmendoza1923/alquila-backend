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
app.use('/api/pagos',     require('./routes/pagos'));   // ← NUEVO
app.use('/api/combos',    require('./routes/combos'));  // ← NUEVO

app.get('/api/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 4000;
const db = require('./db');

db.query(`
  CREATE TABLE IF NOT EXISTS reserva_combo_items (
    id SERIAL PRIMARY KEY,
    reserva_id UUID REFERENCES reservas(id) ON DELETE CASCADE,
    combo_id UUID REFERENCES combos(id) ON DELETE CASCADE,
    mueble_id UUID REFERENCES muebles(id) ON DELETE CASCADE,
    cantidad INT NOT NULL
  );
`).then(() => {
  console.log('Tabla reserva_combo_items verificada/creada con éxito');
  app.listen(PORT, '0.0.0.0', () => console.log(`Servidor corriendo en puerto ${PORT}`));
}).catch(err => {
  console.error('Error al inicializar la tabla reserva_combo_items:', err);
  // Aun así iniciar servidor para evitar caída total si falla la conexión inicial
  app.listen(PORT, '0.0.0.0', () => console.log(`Servidor corriendo en puerto ${PORT}`));
});
