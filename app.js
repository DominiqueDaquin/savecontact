const fs = require('fs');
const path = require('path');
const http = require('http');
const readline = require('readline');
const dns = require('dns').promises;
const { Boom } = require('@hapi/boom');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const csvParser = require('csv-parser');
const pino = require('pino');
const WebSocket = require('ws');

// Configuration
const CSV_FILE = 'contacts.csv';
const CONTACT_PREDEFINI = '23791008288@s.whatsapp.net';
const PHONE_NUMBER = '237677519251';
const AUTH_MODE = process.env.AUTH_MODE || null;

// Créer un serveur HTTP pour servir l'interface web
const server = http.createServer((req, res) => {
    if (req.url === '/') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Erreur serveur');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
    } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('App is alive!');
    }
});

// Créer un serveur WebSocket
const wss = new WebSocket.Server({ server });

// Fonction pour générer un délai aléatoire (en millisecondes)
const delay = (min, max) => new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * (max - min + 1)) + min));

// Interface CLI pour demander le mode de connexion (secours)
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// Fonction pour demander le mode de connexion (CLI)
async function demanderModeConnexionCLI() {
    if (AUTH_MODE === 'qrcode' || AUTH_MODE === 'pairing') {
        console.log(`Mode de connexion prédéfini : ${AUTH_MODE}`);
        return AUTH_MODE;
    }
    return new Promise((resolve) => {
        rl.question('Choisissez le mode de connexion (1 pour QR code, 2 pour Pairing code) : ', (answer) => {
            const mode = answer === '1' ? 'qrcode' : 'pairing';
            console.log(`Mode sélectionné : ${mode}`);
            resolve(mode);
        });
    });
}

// Fonction pour vérifier la résolution DNS
async function verifierDNS() {
    try {
        await dns.lookup('web.whatsapp.com');
        console.log('Résolution DNS réussie pour web.whatsapp.com');
        return true;
    } catch (error) {
        console.error('Erreur DNS : Impossible de résoudre web.whatsapp.com', error);
        return false;
    }
}

// Fonction pour vérifier si un contact existe dans le CSV
async function contactExiste(contactId) {
    return new Promise((resolve) => {
        const contacts = [];
        if (!fs.existsSync(CSV_FILE)) {
            resolve(false);
            return;
        }
        fs.createReadStream(CSV_FILE)
            .pipe(csvParser())
            .on('data', (row) => {
                if (row.contact_id === contactId) {
                    contacts.push(row);
                }
            })
            .on('end', () => {
                resolve(contacts.length > 0);
            });
    });
}

// Fonction pour ajouter un contact au CSV
async function ajouterContactAuCsv(contactId, nom) {
    const csvWriter = createCsvWriter({
        path: CSV_FILE,
        header: [
            { id: 'contact_id', title: 'contact_id' },
            { id: 'nom', title: 'nom' },
            { id: 'date_ajout', title: 'date_ajout' }
        ],
        append: fs.existsSync(CSV_FILE)
    });

    const data = [{
        contact_id: contactId,
        nom: nom || 'Inconnu',
        date_ajout: new Date().toISOString()
    }];

    await csvWriter.writeRecords(data);
    console.log(`Contact ajouté : ${contactId}`);
}

// Fonction pour envoyer le CSV au contact prédéfini avec délai aléatoire
async function envoyerCsv(sock) {
    try {
        await delay(1000, 5000);
        const fileBuffer = fs.readFileSync(CSV_FILE);
        await sock.sendMessage(CONTACT_PREDEFINI, {
            document: fileBuffer,
            fileName: 'contacts.csv',
            mimetype: 'text/csv',
            caption: 'Fichier CSV des contacts mis à jour.'
        });
        console.log('CSV envoyé au contact prédéfini après un délai aléatoire.');
    } catch (error) {
        console.error('Erreur lors de l’envoi du CSV :', error);
    }
}

// Fonction principale pour démarrer le client WhatsApp
async function connecterWhatsApp(attempt = 1, maxAttempts = 10) {
    let authMode = AUTH_MODE;
    let wsClient = null;

    // Attendre le choix du mode via WebSocket ou CLI
    if (!authMode) {
        authMode = await new Promise((resolve) => {
            // Écouter les connexions WebSocket
            wss.on('connection', (ws) => {
                wsClient = ws;
                ws.on('message', (message) => {
                    const data = JSON.parse(message);
                    if (data.type === 'selectMode') {
                        console.log(`Mode sélectionné via interface web : ${data.mode}`);
                        resolve(data.mode);
                        ws.send(JSON.stringify({ type: 'modeSelected', mode: data.mode }));
                    }
                });
            });

            // Fallback sur CLI si aucune connexion WebSocket après 10 secondes
            setTimeout(() => {
                if (!authMode) {
                    console.log('Aucune sélection via interface web, passage au mode CLI...');
                    demanderModeConnexionCLI().then(resolve);
                }
            }, 10000);
        });
    } else {
        console.log(`Mode de connexion prédéfini : ${authMode}`);
    }

    console.log(`Tentative de connexion ${attempt}/${maxAttempts} avec le mode ${authMode}...`);

    // Vérifier la résolution DNS
    const dnsOK = await verifierDNS();
    if (!dnsOK) {
        if (attempt < maxAttempts) {
            const backoffDelay = Math.pow(2, attempt) * 1000;
            console.log(`Problème DNS, nouvelle tentative dans ${backoffDelay/1000} secondes...`);
            await delay(backoffDelay, backoffDelay);
            return connecterWhatsApp(attempt + 1, maxAttempts);
        } else {
            const errorMsg = 'Échec de résolution DNS après plusieurs tentatives.';
            console.error(errorMsg);
            if (wsClient) wsClient.send(JSON.stringify({ type: 'error', message: errorMsg }));
            process.exit(1);
        }
    }

    const { state, saveCreds } = await useMultiFileAuthState('./auth_info');

    const sock = makeWASocket({
        logger: pino({ level: 'info' }),
        browser: ['Custom', 'App', '1.0'],
        connectTimeoutMs: 30000,
        auth: state
    });

    // Gestion des mises à jour de connexion
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr, pairingCode } = update;

        if (qr && authMode === 'qrcode') {
            console.log('QR code généré');
            if (wsClient) {
                wsClient.send(JSON.stringify({ type: 'qr', qr }));
            } else {
                console.log('Scannez ce QR code avec WhatsApp :');
                qrcode.generate(qr, { small: true });
            }
        }

        if (authMode === 'pairing' && !sock.authState.creds.me) {
            try {
                console.log('Génération du pairing code...');
                const code = await sock.requestPairingCode(PHONE_NUMBER);
                const msg = `Entrez ce code dans WhatsApp (Appareils liés > Lier avec numéro de téléphone) : ${code}`;
                console.log(msg);
                if (wsClient) wsClient.send(JSON.stringify({ type: 'pairingCode', code }));
            } catch (error) {
                console.error('Erreur lors de la génération du pairing code :', error);
                if (wsClient) wsClient.send(JSON.stringify({ type: 'error', message: 'Erreur lors de la génération du pairing code.' }));
            }
        }

        if (connection === 'close') {
            const raison = new Boom(lastDisconnect?.error)?.output?.statusCode;
            if (raison === DisconnectReason.loggedOut) {
                const msg = 'Déconnecté. Supprimez le dossier auth_info et relancez.';
                console.log(msg);
                if (wsClient) wsClient.send(JSON.stringify({ type: 'error', message: msg }));
                fs.rmSync('./auth_info', { recursive: true, force: true });
                process.exit(1);
            } else if (attempt < maxAttempts) {
                const backoffDelay = Math.pow(2, attempt) * 1000;
                console.log(`Connexion fermée, nouvelle tentative dans ${backoffDelay/1000} secondes...`);
                if (wsClient) wsClient.send(JSON.stringify({ type: 'retry', attempt, maxAttempts }));
                await delay(backoffDelay, backoffDelay);
                connecterWhatsApp(attempt + 1, maxAttempts);
            } else {
                const errorMsg = 'Échec de connexion après plusieurs tentatives.';
                console.error(errorMsg);
                if (wsClient) wsClient.send(JSON.stringify({ type: 'error', message: errorMsg }));
                process.exit(1);
            }
        }

        if (connection === 'open') {
            console.log('Connexion WhatsApp établie avec succès !');
            if (wsClient) {
                wsClient.send(JSON.stringify({ type: 'connected' }));
                wsClient.send(JSON.stringify({ type: 'running' }));
            }
            rl.close();
        }
    });

    // Sauvegarder les identifiants
    sock.ev.on('creds.update', saveCreds);

    // Écouter les messages entrants
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message.key.fromMe) {
            const contactId = message.key.remoteJid;
            const nom = message.pushName || 'Inconnu';

            const existe = await contactExiste(contactId);
            if (!existe) {
                await ajouterContactAuCsv(contactId, nom);
                await envoyerCsv(sock);
            } else {
                console.log(`Contact déjà existant : ${contactId}`);
            }
        }
    });

    return sock;
}

// Démarrer le serveur et l’application
server.listen(process.env.PORT || 3000, () => {
    console.log('Serveur démarré sur le port', process.env.PORT || 3000);
    connecterWhatsApp().catch((err) => {
        console.error('Erreur au démarrage :', err);
        if (wss.clients) {
            wss.clients.forEach(client => client.send(JSON.stringify({ type: 'error', message: 'Erreur au démarrage de l’application.' })));
        }
        process.exit(1);
    });
});