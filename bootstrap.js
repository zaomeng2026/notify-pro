const modeArg = String(process.argv[2] || '').trim().toLowerCase();
if (modeArg === 'lan' || modeArg === 'cloud') {
  process.env.DEPLOY_MODE = modeArg;
}

require('./server');
