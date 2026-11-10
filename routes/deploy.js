// routes/deploy.js - Endpoint de auto-actualización automática (CI/CD Webhook)
const express = require('express');
const router = express.Router();
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const DEPLOY_SECRET = process.env.DEPLOY_SECRET || 'alquila_deploy_secure_key_2026';

router.post('/webhook', (req, res) => {
  const token = req.headers['x-deploy-token'] || req.query.token || req.body?.secret;

  // Si hay clave configurada, validarla
  if (DEPLOY_SECRET && token !== DEPLOY_SECRET) {
    return res.status(401).json({ error: 'No autorizado: Token de despliegue inválido o ausente' });
  }

  // Detectar rutas de frontend y backend
  const rootDir = path.resolve(__dirname, '../../');
  const frontendDir = fs.existsSync(path.join(rootDir, 'alquila-frontend'))
    ? path.join(rootDir, 'alquila-frontend')
    : path.resolve(__dirname, '../frontend');

  const backendDir = path.resolve(__dirname, '../');

  console.log(`[AutoDeploy] Webhook recibido. Iniciando actualización automática en: ${frontendDir}`);

  // Responder inmediatamente para evitar timeouts
  res.json({
    ok: true,
    message: 'Auto-despliegue iniciado exitosamente en segundo plano',
    timestamp: new Date().toISOString()
  });

  // Comando de actualización según el entorno
  // 1. Actualiza frontend (git pull + build)
  // 2. Si PM2 está disponible, recarga el backend sin caída de servicio
  const updateCmd = `
    cd "${frontendDir}" && git pull origin main && npm run build
  `;

  exec(updateCmd, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
    if (error) {
      console.error(`[AutoDeploy] Error durante la actualización:`, error.message);
      if (stderr) console.error(`[AutoDeploy] stderr:`, stderr);
      return;
    }
    console.log(`[AutoDeploy] ¡Actualización completada con éxito!`);
    console.log(stdout);

    // Si existe backend y PM2, recargarlo suavemente
    exec('pm2 reload all || true', (pm2Err) => {
      if (pm2Err) {
        console.log('[AutoDeploy] PM2 no detectado o no requerido recargar.');
      }
    });
  });
});

// Endpoint de prueba de salud del webhook
router.get('/status', (req, res) => {
  res.json({
    active: true,
    service: 'Alquila Tu Party Auto-Updater',
    time: new Date().toISOString()
  });
});

module.exports = router;
