const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const fs = require('fs');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  maxHttpBufferSize: 500 * 1024 * 1024
});

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

app.use(cors());
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

const dirs = ['uploads/avatars', 'uploads/files', 'uploads/voice'];
dirs.forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const users = new Map();
const messages = new Map();
const groups = new Map();
const userSockets = new Map();
const blockedUsers = new Map();

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, `uploads/${req.body.type || 'files'}`),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});

const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

// API Routes
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Логин и пароль обязательны' });

    for (let user of users.values()) {
      if (user.username.toLowerCase() === username.toLowerCase()) {
        return res.status(400).json({ error: 'Пользователь уже существует' });
      }
    }

    const userId = Date.now().toString();
    const user = {
      id: userId,
      username,
      password: await bcrypt.hash(password, 10),
      avatar: null,
      theme: 'light',
      createdAt: new Date()
    };

    users.set(userId, user);
    const token = jwt.sign({ userId, username }, JWT_SECRET);
    
    res.json({
      token,
      user: { id: userId, username, avatar: user.avatar, theme: user.theme }
    });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка регистрации' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    let foundUser = null;
    
    for (let user of users.values()) {
      if (user.username.toLowerCase() === username.toLowerCase()) {
        foundUser = user;
        break;
      }
    }

    if (!foundUser || !await bcrypt.compare(password, foundUser.password)) {
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    }

    const token = jwt.sign({ userId: foundUser.id, username: foundUser.username }, JWT_SECRET);
    res.json({
      token,
      user: { id: foundUser.id, username: foundUser.username, avatar: foundUser.avatar, theme: foundUser.theme }
    });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка входа' });
  }
});

app.get('/api/search', (req, res) => {
  const { query, userId } = req.query;
  if (!query) return res.json([]);
  
  const results = [];
  for (let user of users.values()) {
    if (user.id !== userId && user.username.toLowerCase().includes(query.toLowerCase())) {
      results.push({ id: user.id, username: user.username, avatar: user.avatar });
    }
  }
  res.json(results);
});

app.get('/api/users/all', (req, res) => {
  const { userId } = req.query;
  const results = [];
  for (let user of users.values()) {
    if (user.id !== userId) {
      results.push({ id: user.id, username: user.username, avatar: user.avatar });
    }
  }
  res.json(results);
});

app.get('/api/user/:id', (req, res) => {
  const user = users.get(req.params.id);
  if (user) {
    res.json({ id: user.id, username: user.username, avatar: user.avatar });
  } else {
    res.status(404).json({ error: 'Не найден' });
  }
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
  res.json({
    filename: req.file.filename,
    path: `/uploads/${req.body.type || 'files'}/${req.file.filename}`,
    size: req.file.size,
    originalName: req.file.originalname
  });
});

app.post('/api/settings/avatar', (req, res) => {
  const user = users.get(req.body.userId);
  if (user) {
    user.avatar = req.body.avatar;
    res.json({ success: true, avatar: user.avatar });
  } else {
    res.status(404).json({ error: 'Не найден' });
  }
});

app.post('/api/settings/username', (req, res) => {
  const { userId, newUsername } = req.body;
  for (let user of users.values()) {
    if (user.id !== userId && user.username.toLowerCase() === newUsername.toLowerCase()) {
      return res.status(400).json({ error: 'Логин занят' });
    }
  }
  const user = users.get(userId);
  if (user) {
    user.username = newUsername;
    res.json({ success: true, username: newUsername });
  } else {
    res.status(404).json({ error: 'Не найден' });
  }
});

app.post('/api/settings/password', async (req, res) => {
  const user = users.get(req.body.userId);
  if (user) {
    user.password = await bcrypt.hash(req.body.newPassword, 10);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Не найден' });
  }
});

app.post('/api/settings/theme', (req, res) => {
  const user = users.get(req.body.userId);
  if (user) {
    user.theme = req.body.theme;
    res.json({ success: true, theme: user.theme });
  } else {
    res.status(404).json({ error: 'Не найден' });
  }
});

app.delete('/api/account', (req, res) => {
  users.delete(req.body.userId);
  res.json({ success: true });
});

// Socket.IO
io.on('connection', (socket) => {
  console.log('Подключен:', socket.id);

  socket.on('user_online', (userId) => {
    userSockets.set(userId, socket.id);
    io.emit('user_status', { userId, online: true });
  });

  socket.on('get_chats', (userId) => {
    const chats = [];
    
    for (let [chatId, msgs] of messages.entries()) {
      if (chatId.includes(userId) && !chatId.startsWith('group_')) {
        const otherUserId = chatId.split('_').find(id => id !== userId);
        const otherUser = users.get(otherUserId);
        if (otherUser) {
          const lastMessage = msgs[msgs.length - 1];
          chats.push({
            id: chatId,
            type: 'private',
            name: otherUser.username,
            avatar: otherUser.avatar,
            lastMessage: lastMessage ? lastMessage.text : '',
            timestamp: lastMessage ? lastMessage.timestamp : Date.now()
          });
        }
      }
    }
    
    for (let [groupId, group] of groups.entries()) {
      if (group.members.includes(userId)) {
        const groupMessages = messages.get(groupId) || [];
        const lastMessage = groupMessages[groupMessages.length - 1];
        chats.push({
          id: groupId,
          type: 'group',
          name: group.name,
          avatar: group.avatar,
          members: group.members.length,
          memberIds: group.members,
          creatorId: group.creatorId,
          lastMessage: lastMessage ? lastMessage.text : '',
          timestamp: lastMessage ? lastMessage.timestamp : group.createdAt
        });
      }
    }
    
    socket.emit('chats_list', chats);
  });

  socket.on('get_messages', ({ chatId, userId }) => {
    const chatMessages = messages.get(chatId) || [];
    const blocked = blockedUsers.get(userId) || [];
    
    const filteredMessages = chatMessages.filter(msg => {
      if (blocked.includes(msg.senderId)) return false;
      if (!chatId.startsWith('group_')) {
        const [user1, user2] = chatId.split('_');
        const otherUserId = user1 === userId ? user2 : user1;
        const otherBlocked = blockedUsers.get(otherUserId) || [];
        return !otherBlocked.includes(userId);
      }
      return true;
    });
    
    socket.emit('messages_history', { chatId, messages: filteredMessages });
  });

  socket.on('send_message', (data) => {
    const { chatId, senderId, text, type, fileUrl, fileName, fileSize } = data;
    const sender = users.get(senderId);
    
    const message = {
      id: Date.now().toString() + Math.random(),
      chatId,
      senderId,
      senderName: sender ? sender.username : 'Unknown',
      senderAvatar: sender ? sender.avatar : null,
      text,
      type: type || 'text',
      fileUrl,
      fileName,
      fileSize,
      timestamp: Date.now(),
      edited: false,
      reactions: []
    };

    if (!messages.has(chatId)) messages.set(chatId, []);
    messages.get(chatId).push(message);

    if (chatId.startsWith('group_')) {
      const group = groups.get(chatId);
      if (group) {
        group.members.forEach(memberId => {
          const socketId = userSockets.get(memberId);
          if (socketId) io.to(socketId).emit('new_message', message);
        });
      }
    } else {
      const [user1, user2] = chatId.split('_');
      const blocked1 = blockedUsers.get(user1) || [];
      const blocked2 = blockedUsers.get(user2) || [];
      
      if (!blocked1.includes(user2)) {
        const socketId1 = userSockets.get(user1);
        if (socketId1) io.to(socketId1).emit('new_message', message);
      }
      if (!blocked2.includes(user1)) {
        const socketId2 = userSockets.get(user2);
        if (socketId2) io.to(socketId2).emit('new_message', message);
      }
    }
  });

  socket.on('edit_message', ({ messageId, chatId, newText, userId }) => {
    const chatMessages = messages.get(chatId);
    if (chatMessages) {
      const message = chatMessages.find(m => m.id === messageId);
      if (message && message.senderId === userId) {
        message.text = newText;
        message.edited = true;
        message.editedAt = Date.now();
        io.emit('message_edited', { chatId, messageId, newText });
      }
    }
  });

  socket.on('delete_message', ({ messageId, chatId, userId }) => {
    const chatMessages = messages.get(chatId);
    if (chatMessages) {
      const index = chatMessages.findIndex(m => m.id === messageId && m.senderId === userId);
      if (index !== -1) {
        chatMessages.splice(index, 1);
        io.emit('message_deleted', { chatId, messageId });
      }
    }
  });

  socket.on('add_reaction', ({ messageId, chatId, userId, emoji }) => {
    const chatMessages = messages.get(chatId);
    if (chatMessages) {
      const message = chatMessages.find(m => m.id === messageId);
      if (message) {
        if (!message.reactions) message.reactions = [];
        const existing = message.reactions.find(r => r.userId === userId);
        if (existing) {
          existing.emoji = emoji;
        } else {
          message.reactions.push({ userId, emoji });
        }
        io.emit('reaction_added', { chatId, messageId, reactions: message.reactions });
      }
    }
  });

  socket.on('create_group', ({ name, members, creatorId, avatar }) => {
    const groupId = 'group_' + Date.now();
    const group = {
      id: groupId,
      name,
      members: [...members, creatorId],
      creatorId,
      avatar,
      createdAt: Date.now()
    };
    
    groups.set(groupId, group);
    messages.set(groupId, []);
    
    group.members.forEach(memberId => {
      const socketId = userSockets.get(memberId);
      if (socketId) io.to(socketId).emit('group_created', group);
    });
  });

  socket.on('add_members_to_group', ({ groupId, newMembers }) => {
    const group = groups.get(groupId);
    if (group) {
      newMembers.forEach(memberId => {
        if (!group.members.includes(memberId)) {
          group.members.push(memberId);
        }
      });
      
      group.members.forEach(memberId => {
        const socketId = userSockets.get(memberId);
        if (socketId) {
          io.to(socketId).emit('group_updated', { groupId, members: group.members });
        }
      });
    }
  });

  socket.on('remove_member', ({ groupId, memberId, requesterId }) => {
    const group = groups.get(groupId);
    if (group && group.creatorId === requesterId) {
      group.members = group.members.filter(id => id !== memberId);
      
      const removedSocketId = userSockets.get(memberId);
      if (removedSocketId) {
        io.to(removedSocketId).emit('removed_from_group', { groupId });
      }
      
      group.members.forEach(id => {
        const socketId = userSockets.get(id);
        if (socketId) {
          io.to(socketId).emit('group_updated', { groupId, members: group.members });
        }
      });
    }
  });

  socket.on('leave_group', ({ groupId, userId }) => {
    const group = groups.get(groupId);
    if (group) {
      if (group.creatorId === userId) {
        // Создатель уходит - удаляем группу
        group.members.forEach(memberId => {
          const socketId = userSockets.get(memberId);
          if (socketId) io.to(socketId).emit('group_deleted', { groupId });
        });
        groups.delete(groupId);
        messages.delete(groupId);
      } else {
        group.members = group.members.filter(id => id !== userId);
        group.members.forEach(memberId => {
          const socketId = userSockets.get(memberId);
          if (socketId) {
            io.to(socketId).emit('group_updated', { groupId, members: group.members });
          }
        });
      }
    }
  });

  socket.on('delete_group', ({ groupId, userId }) => {
    const group = groups.get(groupId);
    if (group && group.creatorId === userId) {
      group.members.forEach(memberId => {
        const socketId = userSockets.get(memberId);
        if (socketId) io.to(socketId).emit('group_deleted', { groupId });
      });
      groups.delete(groupId);
      messages.delete(groupId);
    }
  });

  socket.on('update_group_name', ({ groupId, newName, userId }) => {
    const group = groups.get(groupId);
    if (group && group.creatorId === userId) {
      group.name = newName;
      group.members.forEach(memberId => {
        const socketId = userSockets.get(memberId);
        if (socketId) io.to(socketId).emit('group_name_updated', { groupId, newName });
      });
    }
  });

  socket.on('clear_chat', ({ chatId, userId }) => {
    const group = groups.get(chatId);
    if (chatId.startsWith('group_') && group && group.creatorId !== userId) {
      return; // Только создатель может очищать историю группы
    }
    
    if (messages.has(chatId)) {
      messages.set(chatId, []);
      
      if (chatId.startsWith('group_')) {
        if (group) {
          group.members.forEach(memberId => {
            const socketId = userSockets.get(memberId);
            if (socketId) io.to(socketId).emit('chat_cleared', { chatId });
          });
        }
      } else {
        const [user1, user2] = chatId.split('_');
        [user1, user2].forEach(uid => {
          const socketId = userSockets.get(uid);
          if (socketId) io.to(socketId).emit('chat_cleared', { chatId });
        });
      }
    }
  });

  socket.on('delete_chat', ({ chatId, userId }) => {
    if (!chatId.startsWith('group_')) {
      messages.delete(chatId);
      socket.emit('chat_deleted', { chatId });
    }
  });

  socket.on('block_user', ({ userId, blockedUserId }) => {
    if (!blockedUsers.has(userId)) blockedUsers.set(userId, []);
    const blocked = blockedUsers.get(userId);
    if (!blocked.includes(blockedUserId)) {
      blocked.push(blockedUserId);
    }
    socket.emit('user_blocked', { blockedUserId });
  });

  socket.on('unblock_user', ({ userId, blockedUserId }) => {
    const blocked = blockedUsers.get(userId);
    if (blocked) {
      const index = blocked.indexOf(blockedUserId);
      if (index !== -1) blocked.splice(index, 1);
    }
    socket.emit('user_unblocked', { blockedUserId });
  });

  socket.on('check_blocked', ({ userId, otherUserId }, callback) => {
    const blocked = blockedUsers.get(userId) || [];
    callback({ isBlocked: blocked.includes(otherUserId) });
  });

  socket.on('start_call', ({ chatId, callerId, callType }) => {
    if (chatId.startsWith('group_')) {
      const group = groups.get(chatId);
      if (group) {
        group.members.forEach(memberId => {
          if (memberId !== callerId) {
            const socketId = userSockets.get(memberId);
            if (socketId) {
              io.to(socketId).emit('incoming_call', { chatId, callerId, callType });
            }
          }
        });
      }
    } else {
      const [user1, user2] = chatId.split('_');
      const otherUserId = user1 === callerId ? user2 : user1;
      const socketId = userSockets.get(otherUserId);
      if (socketId) {
        io.to(socketId).emit('incoming_call', { chatId, callerId, callType });
      }
    }
  });

  socket.on('answer_call', ({ chatId, answererId }) => {
    if (chatId.startsWith('group_')) {
      const group = groups.get(chatId);
      if (group) {
        group.members.forEach(memberId => {
          const socketId = userSockets.get(memberId);
          if (socketId) {
            io.to(socketId).emit('call_answered', { chatId, answererId });
          }
        });
      }
    }
  });

  socket.on('end_call', ({ chatId }) => {
    if (chatId.startsWith('group_')) {
      const group = groups.get(chatId);
      if (group) {
        group.members.forEach(memberId => {
          const socketId = userSockets.get(memberId);
          if (socketId) io.to(socketId).emit('call_ended', { chatId });
        });
      }
    } else {
      const [user1, user2] = chatId.split('_');
      [user1, user2].forEach(userId => {
        const socketId = userSockets.get(userId);
        if (socketId) io.to(socketId).emit('call_ended', { chatId });
      });
    }
  });

  socket.on('webrtc_signal', ({ to, signal, from }) => {
    const socketId = userSockets.get(to);
    if (socketId) {
      io.to(socketId).emit('webrtc_signal', { from, signal });
    }
  });

  socket.on('disconnect', () => {
    let disconnectedUserId;
    for (let [userId, socketId] of userSockets.entries()) {
      if (socketId === socket.id) {
        disconnectedUserId = userId;
        userSockets.delete(userId);
        break;
      }
    }
    if (disconnectedUserId) {
      io.emit('user_status', { userId: disconnectedUserId, online: false });
    }
    console.log('Отключен:', socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
