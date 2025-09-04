const fs = require('fs');
const path = require('path');
const http = require('http');
const readline = require('readline');
const dns = require('dns').promises; // Pour vérifier la résolution DNS
const { Boom } = require('@hapi/boom');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const csvParser = require('csv-parser');
const pino = require('pino');

// Configuration
const CSV_FILE = 'contacts.csv'; // Fichier CSV pour stocker les contacts
const CONTACT_PREDEFINI = '23791008288@s.whatsapp.net'; // Numéro du contact prédéfini
const PHONE_NUMBER = '237677519251'; // Votre numéro WhatsApp pour le pairing code
const AUTH_MODE = process.env.AUTH_MODE || null; // 'qrcode' ou 'pairing', null pour demander à l’utilisateur

// Créer un serveur HTTP pour empêcher l’inactivité
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('App is alive!');
});
server.listen(process.env.PORT || 3000, () => {
    console.log('Serveur HTTP pour empêcher l’inactivité actif sur le port', process.env.PORT || 3000);
});

// Fonction pour générer un délai aléatoire (en millisecondes)
const delay = (min, max) => new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * (max - min + 1)) + min));

// Interface pour demander le mode de connexion
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// Fonction pour demander le mode de connexion
async function demanderModeConnexion() {
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
        // Délai aléatoire entre 1 et 5 secondes
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
    const authMode = await demanderModeConnexion();
    console.log(`Tentative de connexion ${attempt}/${maxAttempts} avec le mode ${authMode}...`);

    // Vérifier la résolution DNS avant de tenter la connexion
    const dnsOK = await verifierDNS();
    if (!dnsOK) {
        if (attempt < maxAttempts) {
            const backoffDelay = Math.pow(2, attempt) * 1000;
            console.log(`Problème DNS, nouvelle tentative dans ${backoffDelay/1000} secondes...`);
            await delay(backoffDelay, backoffDelay);
            return connecterWhatsApp(attempt + 1, maxAttempts);
        } else {
            console.error('Échec de résolution DNS après plusieurs tentatives. Arrêt.');
            process.exit(1);
        }
    }

    const { state, saveCreds } = await useMultiFileAuthState('./auth_info'); // Stockage de la session

    const sock = makeWASocket({
        logger: pino({ level: 'info' }), // Logs pour débogage
        browser: ['Custom', 'App', '1.0'], // Personnaliser pour éviter détection
        connectTimeoutMs: 30000, // Timeout de 30 secondes
        auth: state
    });

    // Gestion des mises à jour de connexion
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr, pairingCode } = update;

        if (qr && authMode === 'qrcode') {
            console.log('Scannez ce QR code avec WhatsApp :');
            qrcode.generate(qr, { small: true });
        }

        if (authMode === 'pairing' && !sock.authState.creds.me) {
            try {
                console.log('Génération du pairing code...');
                const code = await sock.requestPairingCode(PHONE_NUMBER);
                console.log(`Entrez ce code dans WhatsApp (Appareils liés > Lier avec numéro de téléphone) : ${code}`);
            } catch (error) {
                console.error('Erreur lors de la génération du pairing code :', error);
            }
        }

        if (connection === 'close') {
            const raison = new Boom(lastDisconnect?.error)?.output?.statusCode;
            if (raison === DisconnectReason.loggedOut) {
                console.log('Déconnecté. Supprimez le dossier auth_info et relancez.');
                fs.rmSync('./auth_info', { recursive: true, force: true });
                process.exit(1);
            } else if (attempt < maxAttempts) {
                const backoffDelay = Math.pow(2, attempt) * 1000;
                console.log(`Connexion fermée, nouvelle tentative dans ${backoffDelay/1000} secondes...`);
                await delay(backoffDelay, backoffDelay);
                connecterWhatsApp(attempt + 1, maxAttempts);
            } else {
                console.error('Échec de connexion après plusieurs tentatives. Arrêt.');
                process.exit(1);
            }
        }

        if (connection === 'open') {
            console.log('Connexion WhatsApp établie avec succès !');
            rl.close(); // Fermer l’interface readline
        }
    });

    // Sauvegarder les identifiants à chaque mise à jour
    sock.ev.on('creds.update', saveCreds);

    // Écouter les messages entrants
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message.key.fromMe) { // Ignorer les messages envoyés par vous
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

// Démarrer l’application
connecterWhatsApp().catch((err) => {
    console.error('Erreur au démarrage :', err);
    process.exit(1);
});