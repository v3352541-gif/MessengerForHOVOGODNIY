const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');
const crypto = require('crypto');
const bodyParser = require('body-parser');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.static(__dirname));

const USERS_FILE = 'users.json';
const PROFILES_FILE = 'profiles.json';
const CHATS_FILE = 'chats.json';
const MESSAGES_FILE = 'messages.json';

if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '');
if (!fs.existsSync(PROFILES_FILE)) fs.writeFileSync(PROFILES_FILE, '');
if (!fs.existsSync(CHATS_FILE)) fs.writeFileSync(CHATS_FILE, JSON.stringify({}));
if (!fs.existsSync(MESSAGES_FILE)) fs.writeFileSync(MESSAGES_FILE, JSON.stringify({}));

// Хранилище активных пользователей
const onlineUsers = new Map(); // userId -> socketId
const userSockets = new Map(); // socketId -> userId

function readJsonLines(filePath) {
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, 'utf8').trim();
    if (!content) return [];
    return content.split('\n')
        .filter(line => line.trim() !== '')
        .map(line => {
            try { return JSON.parse(line); }
            catch (e) { console.error('Ошибка парсинга строки:', line); return null; }
        })
        .filter(Boolean);
}

function writeJsonLines(filePath, items) {
    const lines = items.map(item => JSON.stringify(item));
    fs.writeFileSync(filePath, lines.join('\n') + '\n');
}

function getUsers() {
    return readJsonLines(USERS_FILE);
}

function saveUsers(users) {
    writeJsonLines(USERS_FILE, users);
}

function getProfiles() {
    const entries = readJsonLines(PROFILES_FILE);
    const profiles = {};
    for (const entry of entries) {
        const userId = Object.keys(entry)[0];
        if (userId) profiles[userId] = entry[userId];
    }
    return profiles;
}

function saveProfiles(profiles) {
    const entries = Object.entries(profiles).map(([userId, data]) => {
        const entry = {}; entry[userId] = data; return entry;
    });
    writeJsonLines(PROFILES_FILE, entries);
}

function getChats() {
    try {
        return JSON.parse(fs.readFileSync(CHATS_FILE, 'utf8') || '{}');
    } catch {
        return {};
    }
}

function saveChats(chats) {
    fs.writeFileSync(CHATS_FILE, JSON.stringify(chats, null, 2));
}

function getMessages() {
    try {
        return JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8') || '{}');
    } catch {
        return {};
    }
}

function saveMessages(messages) {
    fs.writeFileSync(MESSAGES_FILE, JSON.stringify(messages, null, 2));
}

function authenticate(req, res, next) {
    const token = req.headers.authorization;
    if (!token) return res.status(401).json({ success: false, message: 'Токен отсутствует' });
    const users = getUsers();
    const user = users.find(u => u.token === token);
    if (!user) return res.status(401).json({ success: false, message: 'Недействительный токен' });
    req.user = user;
    next();
}

// WebSocket подключение
io.on('connection', (socket) => {
    console.log('Новое WebSocket подключение:', socket.id);

    // Аутентификация через WebSocket
    socket.on('authenticate', (token) => {
        const users = getUsers();
        const user = users.find(u => u.token === token);
        if (user) {
            onlineUsers.set(user.id, socket.id);
            userSockets.set(socket.id, user.id);
            socket.userId = user.id;
            
            // Уведомить всех о статусе онлайн
            io.emit('user-status', { userId: user.id, online: true });
            console.log(`Пользователь ${user.username} онлайн`);
        }
    });

    // Печатает сообщение
    socket.on('typing', ({ chatId }) => {
        const userId = userSockets.get(socket.id);
        if (!userId) return;
        
        const targetSocketId = onlineUsers.get(chatId);
        if (targetSocketId) {
            io.to(targetSocketId).emit('user-typing', { userId, chatId: userId });
        }
    });

    // Перестал печатать
    socket.on('stop-typing', ({ chatId }) => {
        const userId = userSockets.get(socket.id);
        if (!userId) return;
        
        const targetSocketId = onlineUsers.get(chatId);
        if (targetSocketId) {
            io.to(targetSocketId).emit('user-stop-typing', { userId, chatId: userId });
        }
    });

    // Отключение
    socket.on('disconnect', () => {
        const userId = userSockets.get(socket.id);
        if (userId) {
            onlineUsers.delete(userId);
            userSockets.delete(socket.id);
            
            // Уведомить всех о статусе оффлайн
            io.emit('user-status', { userId, online: false });
            console.log(`Пользователь ${userId} оффлайн`);
        }
    });
});

// REST API endpoints
app.post('/register', (req, res) => {
    const { firstName, lastName, username, password } = req.body;
    if (!username || !password) {
        return res.json({ success: false, message: 'Не указан username или password' });
    }
    const users = getUsers();
    if (users.some(u => u.username === username)) {
        return res.json({ success: false, message: 'Пользователь с таким username уже существует' });
    }
    const newUser = {
        id: crypto.randomUUID(),
        firstName: firstName || '',
        lastName: lastName || '',
        username,
        password,
        token: crypto.randomUUID()
    };
    users.push(newUser);
    saveUsers(users);
    const profiles = getProfiles();
    profiles[newUser.id] = {
        firstName: newUser.firstName,
        lastName: newUser.lastName,
        username,
        avatar: null
    };
    saveProfiles(profiles);
    res.json({ success: true });
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const users = getUsers();
    const user = users.find(u => u.username === username && u.password === password);
    if (!user) {
        return res.json({ success: false, message: 'Неверный username или пароль' });
    }
    user.token = crypto.randomUUID();
    saveUsers(users);
    res.json({ success: true, token: user.token, id: user.id });
});

app.get('/profile', authenticate, (req, res) => {
    const profiles = getProfiles();
    res.json(profiles[req.user.id] || {});
});

app.get('/profile/:id', authenticate, (req, res) => {
    const profiles = getProfiles();
    const profile = profiles[req.params.id] || {};
    const isOnline = onlineUsers.has(req.params.id);
    res.json({ ...profile, online: isOnline });
});

app.post('/updateProfile', authenticate, (req, res) => {
    const { firstName, lastName, username, avatar } = req.body;
    let users = getUsers();
    const userIndex = users.findIndex(u => u.id === req.user.id);
    if (userIndex === -1) return res.status(404).json({ success: false });
    users[userIndex] = {
        ...users[userIndex],
        firstName: firstName || users[userIndex].firstName,
        lastName: lastName || users[userIndex].lastName,
        username: username || users[userIndex].username
    };
    saveUsers(users);
    let profiles = getProfiles();
    profiles[req.user.id] = {
        firstName: firstName || profiles[req.user.id]?.firstName || '',
        lastName: lastName || profiles[req.user.id]?.lastName || '',
        username: username || profiles[req.user.id]?.username || '',
        avatar: avatar !== undefined ? avatar : profiles[req.user.id]?.avatar || null
    };
    saveProfiles(profiles);
    res.json({ success: true });
});

app.get('/search', authenticate, (req, res) => {
    const { username } = req.query;
    if (!username) return res.json(null);
    const users = getUsers();
    const found = users.find(u => u.username === username && u.id !== req.user.id);
    if (!found) return res.json(null);
    const profiles = getProfiles();
    const profile = profiles[found.id] || {};
    res.json({
        id: found.id,
        username: found.username,
        firstName: found.firstName,
        lastName: found.lastName,
        avatar: profile.avatar
    });
});

app.post('/addChat', authenticate, (req, res) => {
    const { username } = req.body;
    const users = getUsers();
    const target = users.find(u => u.username === username);
    if (!target) return res.status(404).json({ success: false, message: 'Пользователь не найден' });
    let chats = getChats();
    if (!chats[req.user.id]) chats[req.user.id] = [];
    if (!chats[req.user.id].some(c => c.id === target.id)) {
        const p = getProfiles()[target.id] || {};
        chats[req.user.id].push({
            id: target.id,
            username: target.username,
            firstName: target.firstName,
            lastName: target.lastName,
            avatar: p.avatar
        });
    }
    if (!chats[target.id]) chats[target.id] = [];
    if (!chats[target.id].some(c => c.id === req.user.id)) {
        const p = getProfiles()[req.user.id] || {};
        chats[target.id].push({
            id: req.user.id,
            username: req.user.username,
            firstName: req.user.firstName,
            lastName: req.user.lastName,
            avatar: p.avatar
        });
    }
    saveChats(chats);
    let messages = getMessages();
    const chatKey = [req.user.id, target.id].sort().join('-');
    if (!messages[chatKey]) messages[chatKey] = [];
    saveMessages(messages);
    res.json({ success: true });
});

app.get('/chats', authenticate, (req, res) => {
    const chats = getChats();
    const userChats = (chats[req.user.id] || []).map(chat => ({
        ...chat,
        online: onlineUsers.has(chat.id)
    }));
    res.json(userChats);
});

app.post('/sendMessage', authenticate, (req, res) => {
    const { chatId, text, image } = req.body;
    if (!chatId || (!text?.trim() && !image)) return res.status(400).json({ success: false });
    
    const chatKey = [req.user.id, chatId].sort().join('-');
    let messages = getMessages();
    if (!messages[chatKey]) messages[chatKey] = [];
    
    const newMessage = {
        id: crypto.randomUUID(),
        sender: req.user.id,
        text: text?.trim() || '',
        image: image || null,
        time: new Date().toISOString(),
        reactions: [],
        edited: false,
        deleted: false
    };
    
    messages[chatKey].push(newMessage);
    saveMessages(messages);
    
    // Отправить сообщение через WebSocket получателю
    const targetSocketId = onlineUsers.get(chatId);
    if (targetSocketId) {
        io.to(targetSocketId).emit('new-message', {
            chatId: req.user.id,
            message: { ...newMessage, sent: false }
        });
    }
    
    res.json({ success: true, message: newMessage });
});

app.get('/messages/:chatId', authenticate, (req, res) => {
    const targetId = req.params.chatId;
    const chatKey = [req.user.id, targetId].sort().join('-');
    const messages = getMessages()[chatKey] || [];
    const result = messages.map(msg => ({
        ...msg,
        sent: msg.sender === req.user.id
    }));
    res.json(result);
});

app.post('/react', authenticate, (req, res) => {
    const { messageId, chatId, emoji } = req.body;
    if (!messageId || !chatId || !emoji) {
        return res.status(400).json({ success: false, message: "messageId, chatId, emoji required" });
    }

    const chatKey = [req.user.id, chatId].sort().join('-');
    let messages = getMessages();
    let chatMessages = messages[chatKey] || [];

    const msgIndex = chatMessages.findIndex(m => m.id === messageId);
    if (msgIndex === -1) {
        return res.status(404).json({ success: false, message: "Сообщение не найдено" });
    }

    let msg = chatMessages[msgIndex];
    if (!msg.reactions) msg.reactions = [];

    let reaction = msg.reactions.find(r => r.emoji === emoji);
    if (!reaction) {
        reaction = { emoji, users: [] };
        msg.reactions.push(reaction);
    }

    const userId = req.user.id;
    const alreadyReacted = reaction.users.includes(userId);

    if (alreadyReacted) {
        reaction.users = reaction.users.filter(id => id !== userId);
        if (reaction.users.length === 0) {
            msg.reactions = msg.reactions.filter(r => r.emoji !== emoji);
        }
    } else {
        reaction.users.push(userId);
    }

    chatMessages[msgIndex] = msg;
    messages[chatKey] = chatMessages;
    saveMessages(messages);

    // Уведомить через WebSocket
    const targetSocketId = onlineUsers.get(chatId);
    if (targetSocketId) {
        io.to(targetSocketId).emit('message-updated', {
            chatId: req.user.id,
            messageId,
            reactions: msg.reactions
        });
    }

    res.json({ success: true, reactions: msg.reactions });
});

app.patch('/message/:messageId', authenticate, (req, res) => {
    const { chatId, text } = req.body;
    const messageId = req.params.messageId;

    if (!chatId || !text?.trim()) {
        return res.status(400).json({ success: false });
    }

    const chatKey = [req.user.id, chatId].sort().join('-');
    let messages = getMessages();
    let chatMessages = messages[chatKey] || [];

    const msgIndex = chatMessages.findIndex(m => m.id === messageId);
    if (msgIndex === -1) return res.status(404).json({ success: false });

    const msg = chatMessages[msgIndex];

    if (msg.sender !== req.user.id) {
        return res.status(403).json({ success: false, message: "Не твоё сообщение" });
    }

    const sentTime = new Date(msg.time).getTime();
    const now = Date.now();
    if (now - sentTime > 30 * 60 * 1000) {
        return res.status(403).json({ success: false, message: "Слишком поздно для редактирования" });
    }

    msg.text = text.trim();
    msg.edited = true;
    msg.editTime = new Date().toISOString();

    chatMessages[msgIndex] = msg;
    messages[chatKey] = chatMessages;
    saveMessages(messages);

    // Уведомить через WebSocket
    const targetSocketId = onlineUsers.get(chatId);
    if (targetSocketId) {
        io.to(targetSocketId).emit('message-updated', {
            chatId: req.user.id,
            messageId,
            text: msg.text,
            edited: true
        });
    }

    res.json({ success: true, message: msg });
});

app.delete('/message/:messageId', authenticate, (req, res) => {
    const { chatId } = req.body;
    const messageId = req.params.messageId;

    if (!chatId) return res.status(400).json({ success: false });

    const chatKey = [req.user.id, chatId].sort().join('-');
    let messages = getMessages();
    let chatMessages = messages[chatKey] || [];

    const msgIndex = chatMessages.findIndex(m => m.id === messageId);
    if (msgIndex === -1) return res.status(404).json({ success: false });

    const msg = chatMessages[msgIndex];

    if (msg.sender !== req.user.id) {
        return res.status(403).json({ success: false, message: "Не твоё сообщение" });
    }

    msg.deleted = true;
    msg.text = "";

    chatMessages[msgIndex] = msg;
    messages[chatKey] = chatMessages;
    saveMessages(messages);

    // Уведомить через WebSocket
    const targetSocketId = onlineUsers.get(chatId);
    if (targetSocketId) {
        io.to(targetSocketId).emit('message-updated', {
            chatId: req.user.id,
            messageId,
            deleted: true
        });
    }

    res.json({ success: true });
});

const PORT = 3000;
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/login.html');
});

server.listen(PORT, () => {
    console.log(`Сервер запущен на http://localhost:${PORT}`);
});