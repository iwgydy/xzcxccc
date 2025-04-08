const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const { Api } = require('telegram/tl');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const express = require('express');

let chalk;
(async () => {
    chalk = (await import('chalk')).default;
})();

const API_ID = 23491254; // แทนที่ด้วย API ID ของคุณ
const API_HASH = '5f21a8b3cd574ea9c96d1f1898932173'; // แทนที่ด้วย API Hash ของคุณ
const ADMIN_ID = 7520172820;

const clients = [];
const sessionsDir = path.join(__dirname, 'sessions');
if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir);

const botSettingsFilePath = path.join(__dirname, 'bot_settings.json');
const groupCountFilePath = path.join(__dirname, 'group_count.json');

let botLogs = [];
let apiStats = { totalLinksSent: 0, successfulLinks: 0, failedLinks: 0 };
let totalGroupsJoined = 0;
let botSettings = {
    autoMessages: [],
    schedule: {}
};

const app = express();
const port = 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

function loadOrCreateGroupCountFile() {
    if (!fs.existsSync(groupCountFilePath)) {
        fs.writeFileSync(groupCountFilePath, JSON.stringify({ total: 0 }, null, 2));
        console.log('🌟 สร้างไฟล์ group_count.json อัตโนมัติ');
        botLogs.push({ text: `[${new Date().toLocaleTimeString()}] 🌟 สร้างไฟล์ group_count.json อัตโนมัติ`, color: '#00ff00' });
    }
    const data = JSON.parse(fs.readFileSync(groupCountFilePath, 'utf8'));
    totalGroupsJoined = data.total || 0;
    return totalGroupsJoined;
}

function saveGroupCountFile() {
    fs.writeFileSync(groupCountFilePath, JSON.stringify({ total: totalGroupsJoined }, null, 2));
}

function loadOrCreateBotSettings() {
    if (!fs.existsSync(botSettingsFilePath)) {
        fs.writeFileSync(botSettingsFilePath, JSON.stringify({ autoMessages: [], schedule: {} }, null, 2));
        console.log('🌟 สร้างไฟล์ bot_settings.json อัตโนมัติ');
        botLogs.push({ text: `[${new Date().toLocaleTimeString()}] 🌟 สร้างไฟล์ bot_settings.json อัตโนมัติ`, color: '#00ff00' });
    }
    return JSON.parse(fs.readFileSync(botSettingsFilePath, 'utf8'));
}

function saveBotSettings() {
    fs.writeFileSync(botSettingsFilePath, JSON.stringify(botSettings, null, 2));
}

async function reconnectClient(client, phone) {
    if (!client.connected) {
        console.log(`⚠️ บัญชี ${phone} หลุดการเชื่อมต่อ กำลังเชื่อมต่อใหม่...`);
        botLogs.push({ text: `[${new Date().toLocaleTimeString()}] ⚠️ บัญชี ${phone} หลุดการเชื่อมต่อ กำลังเชื่อมต่อใหม่`, color: '#ffff00' });
        try {
            await client.connect();
            console.log(`🌟 บัญชี ${phone} เชื่อมต่อใหม่สำเร็จ`);
            botLogs.push({ text: `[${new Date().toLocaleTimeString()}] 🌟 บัญชี ${phone} เชื่อมต่อใหม่สำเร็จ`, color: '#00ff00' });
        } catch (error) {
            console.log(`❌ ล้มเหลวในการเชื่อมต่อใหม่ ${phone}: ${error.message}`);
            botLogs.push({ text: `[${new Date().toLocaleTimeString()}] ❌ ล้มเหลวในการเชื่อมต่อใหม่ ${phone}: ${error.message}`, color: '#ff5555' });
        }
    }
}

async function handleNewMessage(event, client) {
    const botIndex = clients.indexOf(client) + 1;
    const botLabel = `[บอทตัวที่ ${botIndex}]`;
    const message = event.message;
    if (!message || !message.chatId || !message.senderId) return;

    const chatId = String(message.chatId.value || '');
    const userId = Number(message.senderId.value || 0);
    const text = message.text || '';

    botLogs.push({ text: `[${new Date().toLocaleTimeString()}] ${botLabel} 📩 รับข้อความจาก ${chatId} - ${userId}: ${text}`, color: '#00ffcc' });

    const inviteLinkRegex = /(?:https?:\/\/)?t\.me\/(?:joinchat\/|\+)?([a-zA-Z0-9_-]+)/i;
    const inviteMatch = text.match(inviteLinkRegex);

    if (inviteMatch) {
        const inviteCode = inviteMatch[1];
        botLogs.push({ text: `[${new Date().toLocaleTimeString()}] ${botLabel} 🌠 พบลิงก์เชิญ: ${inviteMatch[0]}`, color: '#ffff00' });

        try {
            const joinResult = await client.invoke(new Api.messages.ImportChatInvite({ hash: inviteCode }));
            const newChatId = String(joinResult.chats[0].id.value);

            totalGroupsJoined++;
            saveGroupCountFile();

            botLogs.push({ text: `[${new Date().toLocaleTimeString()}] ${botLabel} 🌟 เข้าร่วมกลุ่มใหม่ ${newChatId} สำเร็จ (กลุ่มที่ ${totalGroupsJoined})`, color: '#00ff00' });
        } catch (joinError) {
            botLogs.push({ text: `[${new Date().toLocaleTimeString()}] ${botLabel} ❌ ล้มเหลวในการเข้าร่วมกลุ่ม: ${joinError.message}`, color: '#ff5555' });
        }
    }
}

async function sendScheduledMessages() {
    botSettings = loadOrCreateBotSettings();
    const now = Date.now();

    for (const [minutes, settings] of Object.entries(botSettings.schedule)) {
        if (settings.lastSent && (now - settings.lastSent) < (parseInt(minutes) * 60 * 1000)) {
            continue;
        }

        for (const client of clients) {
            if (!client.connected) {
                await reconnectClient(client, client.phone);
                if (!client.connected) continue;
            }

            try {
                const dialogs = await client.getDialogs();
                console.log(`[${client.phone}] กำลังส่งข้อความไปยัง ${dialogs.length} กลุ่ม`);
                botLogs.push({ text: `[${new Date().toLocaleTimeString()}] [${client.phone}] 📤 กำลังส่งไป ${dialogs.length} กลุ่ม`, color: '#00ffcc' });

                for (const dialog of dialogs) {
                    if (dialog.isGroup || dialog.isChannel) {
                        try {
                            if (settings.imagePath && fs.existsSync(settings.imagePath)) {
                                await client.sendFile(dialog.id, {
                                    file: settings.imagePath,
                                    caption: settings.message || ''
                                });
                                console.log(`[${client.phone}] ส่งรูปภาพไป ${dialog.title}: ${settings.imagePath}`);
                                botLogs.push({ text: `[${new Date().toLocaleTimeString()}] [${client.phone}] 📸 ส่งรูปภาพไป ${dialog.title}`, color: '#00ff00' });
                            } else if (settings.message && settings.message.trim()) {
                                await client.sendMessage(dialog.id, { message: settings.message });
                                console.log(`[${client.phone}] ส่งข้อความไป ${dialog.title}: ${settings.message}`);
                                botLogs.push({ text: `[${new Date().toLocaleTimeString()}] [${client.phone}] 📩 ส่งข้อความไป ${dialog.title}`, color: '#00ff00' });
                            }
                            await new Promise(resolve => setTimeout(resolve, 13000)); // ดีเลย์ 13 วินาที
                        } catch (sendError) {
                            console.log(`[${client.phone}] ❌ ไม่สามารถส่งไป ${dialog.title}: ${sendError.message}`);
                            botLogs.push({ text: `[${new Date().toLocaleTimeString()}] [${client.phone}] ❌ ไม่สามารถส่งไป ${dialog.title}: ${sendError.message}`, color: '#ff5555' });
                        }
                    }
                }
                settings.lastSent = now;
                saveBotSettings();
            } catch (error) {
                console.log(`[${client.phone}] ❌ ข้อผิดพลาดในการดึง dialogs: ${error.message}`);
                botLogs.push({ text: `[${new Date().toLocaleTimeString()}] [${client.phone}] ❌ ข้อผิดพลาดในการดึง dialogs: ${error.message}`, color: '#ff5555' });
            }
        }
    }

    setTimeout(sendScheduledMessages, 60000); // ตรวจสอบทุก 1 นาที
}

app.get('/api/accounts', (req, res) => {
    const accounts = clients.map((client, index) => ({
        id: index,
        phone: client.phone || 'Unknown',
        status: client.connected ? 'Connected' : 'Disconnected'
    }));
    res.json(accounts);
});

app.post('/api/send-code', async (req, res) => {
    const { phone } = req.body;
    const phoneRegex = /^\+\d{10,12}$/;

    if (!phone || !phoneRegex.test(phone)) {
        return res.status(400).json({ error: 'เบอร์ไม่ถูกต้อง ต้องใช้รูปแบบสากล เช่น +66971432317' });
    }

    const sessionFile = path.join(sessionsDir, `${phone}.txt`);
    let sessionString = fs.existsSync(sessionFile) ? fs.readFileSync(sessionFile, 'utf8') : '';
    const session = new StringSession(sessionString);
    const client = new TelegramClient(session, API_ID, API_HASH, { connectionRetries: 20, timeout: 120000 });
    client.phone = phone;

    try {
        await client.connect();
        if (await client.isUserAuthorized()) {
            if (!clients.some(c => c.phone === phone)) {
                clients.push(client);
                setupClientEvents(client);
            }
            return res.json({ message: `บัญชี ${phone} เชื่อมต่อสำเร็จ (มีเซสชันอยู่แล้ว)` });
        }

        const sendCodeResult = await client.invoke(new Api.auth.SendCode({
            phoneNumber: phone,
            apiId: API_ID,
            apiHash: API_HASH,
            settings: new Api.CodeSettings({})
        }));

        client.phoneCodeHash = sendCodeResult.phoneCodeHash;
        if (!clients.some(c => c.phone === phone)) clients.push(client);
        res.json({ message: `ส่งรหัสยืนยันไปยัง ${phone} เรียบร้อยแล้ว`, phone });
    } catch (error) {
        botLogs.push({ text: `[${new Date().toLocaleTimeString()}] ❌ ข้อผิดพลาดใน /api/send-code: ${error.message}`, color: '#ff5555' });
        res.status(500).json({ error: `เกิดข้อผิดพลาด: ${error.message}` });
    }
});

app.post('/api/verify-code', async (req, res) => {
    const { phone, code, password } = req.body;
    const client = clients.find(c => c.phone === phone && c.phoneCodeHash);
    if (!client) return res.status(400).json({ error: 'ไม่พบเซสชันสำหรับเบอร์นี้ กรุณาส่งรหัสใหม่' });

    try {
        await client.invoke(new Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash: client.phoneCodeHash, phoneCode: code }));
    } catch (err) {
        if (err.errorMessage === 'SESSION_PASSWORD_NEEDED') {
            if (!password) return res.status(401).json({ error: 'ต้องการรหัสผ่าน 2FA', requiresPassword: true });
            try {
                await client.invoke(new Api.auth.CheckPassword({ password }));
            } catch (passwordErr) {
                return res.status(401).json({ error: `รหัสผ่านไม่ถูกต้อง: ${passwordErr.message}` });
            }
        } else {
            return res.status(400).json({ error: `รหัสยืนยันไม่ถูกต้อง: ${err.message}` });
        }
    }

    fs.writeFileSync(path.join(sessionsDir, `${phone}.txt`), client.session.save());
    setupClientEvents(client);
    console.log(`🌟 ล็อกอินบัญชี ${phone} สำเร็จ`);
    botLogs.push({ text: `[${new Date().toLocaleTimeString()}] 🌟 ล็อกอินบัญชี ${phone} สำเร็จ`, color: '#00ff00' });
    res.json({ message: `ล็อกอินบัญชี ${phone} สำเร็จ` });
});

app.post('/api/set-schedule', async (req, res) => {
    const { time, message, imageData } = req.body;
    if (!time || isNaN(time)) return res.status(400).json({ error: 'กรุณาระบุจำนวนนาที' });

    const minutes = parseInt(time);
    let imagePath = null;

    if (imageData) {
        const imageBuffer = Buffer.from(imageData.split(',')[1], 'base64');
        const fileName = `image_${Date.now()}.jpg`;
        const uploadsDir = path.join(__dirname, 'uploads');
        if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
        imagePath = path.join(uploadsDir, fileName);
        fs.writeFileSync(imagePath, imageBuffer);
    }

    botSettings = loadOrCreateBotSettings();
    botSettings.schedule[minutes] = {
        message: message || '',
        imagePath: imagePath || null,
        lastSent: null // จะเริ่มส่งทันทีในรอบถัดไป
    };
    saveBotSettings();

    res.json({ message: `ตั้งเวลาส่งข้อความ/รูปภาพทุก ${minutes} นาทีสำเร็จ` });
    console.log(`🌟 ตั้งเวลาส่งทุก ${minutes} นาทีสำเร็จ`);
    botLogs.push({ text: `[${new Date().toLocaleTimeString()}] 🌟 ตั้งเวลาส่งทุก ${minutes} นาทีสำเร็จ`, color: '#00ff00' });
});

app.delete('/api/delete-bot', async (req, res) => {
    const { phone } = req.body;
    const clientIndex = clients.findIndex(c => c.phone === phone);
    if (clientIndex === -1) return res.status(400).json({ error: 'ไม่พบบัญชีนี้ในระบบ' });

    const client = clients[clientIndex];
    const sessionFile = path.join(sessionsDir, `${phone}.txt`);

    try {
        if (client.connected) await client.disconnect();
        if (fs.existsSync(sessionFile)) fs.unlinkSync(sessionFile);
        clients.splice(clientIndex, 1);
        res.json({ message: `ลบ bot ${phone} สำเร็จ` });
        console.log(`🗑️ ลบ bot ${phone} เรียบร้อย`);
        botLogs.push({ text: `[${new Date().toLocaleTimeString()}] 🗑️ ลบ bot ${phone} เรียบร้อย`, color: '#ff5555' });
    } catch (error) {
        res.status(500).json({ error: `เกิดข้อผิดพลาดในการลบ: ${error.message}` });
        console.log(`❌ ข้อผิดพลาดในการลบ bot ${phone}: ${error.message}`);
        botLogs.push({ text: `[${new Date().toLocaleTimeString()}] ❌ ข้อผิดพลาดในการลบ bot ${phone}: ${error.message}`, color: '#ff5555' });
    }
});

app.get('/api/schedule-info', (req, res) => {
    botSettings = loadOrCreateBotSettings();
    res.json({ schedule: botSettings.schedule });
});

function setupClientEvents(client) {
    client.addEventHandler(event => handleNewMessage(event, client), new NewMessage({}));
}

async function startServer() {
    loadOrCreateGroupCountFile();
    botSettings = loadOrCreateBotSettings();

    const sessionFiles = fs.readdirSync(sessionsDir).filter(file => file.endsWith('.txt'));
    for (const sessionFile of sessionFiles) {
        const phone = sessionFile.replace('.txt', '');
        const sessionString = fs.readFileSync(path.join(sessionsDir, sessionFile), 'utf8');
        const session = new StringSession(sessionString);
        const client = new TelegramClient(session, API_ID, API_HASH, { connectionRetries: 20 });
        client.phone = phone;

        try {
            await client.connect();
            if (await client.isUserAuthorized()) {
                clients.push(client);
                setupClientEvents(client);
                console.log(`🌟 โหลดบัญชี ${phone} สำเร็จ`);
                botLogs.push({ text: `[${new Date().toLocaleTimeString()}] 🌟 โหลดบัญชี ${phone} สำเร็จ`, color: '#00ff00' });
            } else {
                fs.unlinkSync(path.join(sessionsDir, sessionFile));
            }
        } catch (error) {
            console.log(`❌ ข้อผิดพลาดในการโหลด ${phone}: ${error.message}`);
            botLogs.push({ text: `[${new Date().toLocaleTimeString()}] ❌ ข้อผิดพลาดในการโหลด ${phone}: ${error.message}`, color: '#ff5555' });
        }
    }

    sendScheduledMessages();

    app.listen(port, () => {
        console.log(`🚀 เซิร์ฟเวอร์ทำงานที่ http://0.0.0.0:${port}`);
        botLogs.push({ text: `[${new Date().toLocaleTimeString()}] 🚀 เซิร์ฟเวอร์ทำงานที่ http://0.0.0.0:${port}`, color: '#00ffcc' });
    });
}

startServer();