// PM2 config — inicia o gateway automaticamente no boot do Windows
// Uso: pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: 'whatsapp-gateway',
      script: 'server.js',
      interpreter: 'node',
      node_args: '--experimental-vm-modules',

      // Reinicia automaticamente se cair
      watch: false,
      autorestart: true,
      max_restarts: 50,
      min_uptime: '10s',
      restart_delay: 5000,

      // Variáveis de ambiente (edite com seus valores)
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
        // Substitua com a URL real do seu deploy Vercel:
        VERCEL_URL: 'https://agendeimobiliario.vercel.app',
        // Copie do Supabase → Project Settings → API:
        SUPABASE_URL: '',
        SUPABASE_SERVICE_ROLE_KEY: '',
        // Número do corretor (com DDI, sem +):
        CORRETOR_PHONE: '556198483775',
      },

      // Logs
      out_file: './logs/gateway.log',
      error_file: './logs/error.log',
      log_date_format: 'DD/MM HH:mm:ss',
      merge_logs: true,

      // Máximo de memória antes de reiniciar (segurança)
      max_memory_restart: '500M',
    },
  ],
}
