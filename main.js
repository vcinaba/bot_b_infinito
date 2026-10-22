const pino = require('pino');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const LOGGING = 'debug';
const logger = pino({
  level: LOGGING,
  transport: {
    target: 'pino-pretty',
    options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' }
  }
});

const API_URL = 'https://www.tesourodireto.com.br/o/historico-rentabilidade/187?days=30';
const BASE_INTERVAL_MS = 5 * 60 * 1000; 
const GROUP_NAME = 'B do Infinito';

let lastYieldRate = null;
let lastUnitPrice = null;

const whatsappClient = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { headless: true }
});

whatsappClient.on('qr', (qr) => {
  logger.info('Scan the QR code below to authenticate WhatsApp:');
  qrcode.generate(qr, { small: true });
});

whatsappClient.on('loading_screen', (percent, message) => {
  logger.info(`Sincronizando: ${percent}% - ${message}`);
});

whatsappClient.on('ready', () => {
  logger.info('WhatsApp Client is ready! Waiting 10s for chat list to sync...');
  setTimeout(fetchTreasuryData, 10000);
});

process.on('SIGINT', async () => {
  logger.info('Shutting down safely. Closing browser...');
  await whatsappClient.destroy();
  process.exit(0);
});

whatsappClient.initialize();

function formatNumber(value) {
  return Number(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function isMarketOpen() {
  const now = new Date();
  const brtHour = parseInt(
    now.toLocaleTimeString('en-US', {
      timeZone: 'America/Sao_Paulo',
      hour: '2-digit',
      hour12: false,
    }),
    10
  );
  return brtHour >= 9 && brtHour < 18;
}

async function sendGroupMessage(messageText) {
  try {
    logger.debug('Buscando lista de chats...');
    const chats = await whatsappClient.getChats();
    
    if (!chats || chats.length === 0) {
      logger.warn('Lista de chats vazia. O WhatsApp ainda está sincronizando o histórico. Tentarei no próximo ciclo.');
      return;
    }

    const targetGroup = chats.find((chat) => chat.isGroup && chat.name === GROUP_NAME);

    if (targetGroup) {
      await whatsappClient.sendMessage(targetGroup.id._serialized, messageText);
      logger.info(`Message successfully sent to group: ${GROUP_NAME}`);
    } else {
      logger.error(`Group "${GROUP_NAME}" not found. Certifique-se de que o nome está exato e que o chat não está arquivado.`);
    }
  } catch (error) {
    logger.error({ err: error.message }, 'Failed to send WhatsApp message');
  }
}

function scheduleNextFetch() {
  const jitter = Math.floor(Math.random() * 60001) - 30000;
  const nextInterval = BASE_INTERVAL_MS + jitter;
  
  logger.debug(`Next check scheduled in ${(nextInterval / 1000).toFixed(1)} seconds.`);
  setTimeout(fetchTreasuryData, nextInterval);
}

async function fetchTreasuryData() {
  if (!isMarketOpen()) {
    logger.debug('Market is closed. Skipping fetch.');
    scheduleNextFetch();
    return;
  }

  try {
    const response = await fetch(API_URL);
    if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);

    const jsonData = await response.json();
    const treasuryData = jsonData.TrsrBd;

    const today = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    let targetIndex = treasuryData.label.indexOf(today);
    let referenceDate = today;

    if (targetIndex === -1) {
      targetIndex = treasuryData.label.length - 1;
      referenceDate = treasuryData.label[targetIndex];
    }

// Pega o índice do dia útil anterior (protegido contra index out of bounds)
    const previousIndex = targetIndex > 0 ? targetIndex - 1 : 0;
    const previousYieldRate = treasuryData.anulInvstmtRate[previousIndex];
    const previousUnitPrice = treasuryData.untrInvstmtVal[previousIndex];

    const currentYieldRate = treasuryData.anulInvstmtRate[targetIndex];
    const currentUnitPrice = treasuryData.untrInvstmtVal[targetIndex];

    // Calcula bps: diferença multiplicada por 100 e arredondada
    const bpsDiff = Math.round((currentYieldRate - previousYieldRate) * 100);
    const bpsSign = bpsDiff > 0 ? '+' : '';

    // Calcula variação percentual do PU: (Hoje / Ontem) - 1
    const puDiffPercent = ((currentUnitPrice / previousUnitPrice) - 1) * 100;
    const puSign = puDiffPercent > 0 ? '+' : '';
    const formattedPuDiff = `${puSign}${formatNumber(puDiffPercent)}%`;

    const formattedYield = formatNumber(currentYieldRate);
    const formattedPrice = formatNumber(currentUnitPrice);

    // Formatação de data/hora (dd/mm/yyyy hh:mm)
    const now = new Date();
    const timeString = now.toLocaleTimeString('pt-BR', { 
      timeZone: 'America/Sao_Paulo', 
      hour: '2-digit', 
      minute: '2-digit' 
    });
    const formattedDateTime = `${referenceDate} ${timeString}`;

    if (currentYieldRate !== lastYieldRate || currentUnitPrice !== lastUnitPrice) {
      const message = `📈 *Tesouro Direto Update*\n\n` +
                      `*Date:* ${formattedDateTime}\n` +
                      // `*Bond:* ${treasuryData.nm}\n` +
                      `*Yield:* ${formattedYield}%\n` +
                      `*Price:* R$ ${formattedPrice}\n` +
                      `*Variação diária:* ${bpsSign}${bpsDiff} bps (${formattedPuDiff})`;

      logger.info({ 
        yieldRate: formattedYield, 
        unitPrice: formattedPrice, 
        bpsDiff, 
        puDiff: formattedPuDiff 
      }, 'Data updated. Sending message.');
      
      await sendGroupMessage(message);

      lastYieldRate = currentYieldRate;
      lastUnitPrice = currentUnitPrice;
    } else {
      logger.debug('No changes detected in Treasury data.');
    }
  } catch (error) {
    logger.error({ err: error.message }, 'Failed to fetch Treasury API');
  } finally {
    scheduleNextFetch();
  }
}
