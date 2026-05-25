require('dotenv').config();
const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}));
app.use(express.json());

// Rutas
app.use('/api/auth',      require('./routes/auth'));
app.use('/api/muebles',   require('./routes/muebles'));
app.use('/api/reservas',  require('./routes/reservas'));
app.use('/api/categorias',require('./routes/categorias'));
app.use('/api/admin',     require('./routes/admin'));

app.get('/api/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
