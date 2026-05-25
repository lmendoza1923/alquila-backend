const jwt = require('jsonwebtoken');

const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token requerido' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
};

const admin = (req, res, next) => {
  auth(req, res, () => {
    if (req.user.rol !== 'admin') return res.status(403).json({ error: 'Acceso denegado' });
    next();
  });
};

module.exports = { auth, admin };
