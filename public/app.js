let socket;
let currentUser = null;
let currentChat = null;
let mediaRecorder = null;
let audioChunks = [];
let recordingStartTime = null;
let peerConnection = null;
let localStream = null;
let remoteStream = null;
let inCall = false;

const API_URL = window.location.origin;

const iceServers = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

document.addEventListener('DOMContentLoaded', () => {
    initAuth();
    initTheme();
    
    const token = localStorage.getItem('token');
    if (token) {
        const userData = JSON.parse(localStorage.getItem('user'));
        if (userData) {
            currentUser = userData;
            showMainApp();
        }
    }
});

function initAuth() {
    document.getElementById('loginBtn').addEventListener('click', login);
    document.getElementById('registerBtn').addEventListener('click', register);
    document.getElementById('authPassword').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') login();
    });
}

async function login() {
    const username = document.getElementById('authUsername').value.trim();
    const password = document.getElementById('authPassword').value;
    
    if (!username || !password) {
        showAuthError('Заполните все поля');
        return;
    }
    
    try {
        const response = await fetch(`${API_URL}/api/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            localStorage.setItem('token', data.token);
            localStorage.setItem('user', JSON.stringify(data.user));
            currentUser = data.user;
            showMainApp();
        } else {
            showAuthError(data.error);
        }
    } catch (error) {
        showAuthError('Ошибка подключения');
    }
}

async function register() {
    const username = document.getElementById('authUsername').value.trim();
    const password = document.getElementById('authPassword').value;
    
    if (!username || !password) {
        showAuthError('Заполните все поля');
        return;
    }
    
    if (password.length < 4) {
        showAuthError('Пароль минимум 4 символа');
        return;
    }
    
    try {
        const response = await fetch(`${API_URL}/api/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            localStorage.setItem('token', data.token);
            localStorage.setItem('user', JSON.stringify(data.user));
            currentUser = data.user;
            showMainApp();
        } else {
            showAuthError(data.error);
        }
    } catch (error) {
        showAuthError('Ошибка подключения');
    }
}

function showAuthError(msg) {
    const el = document.getElementById('authError');
    el.textContent = msg;
    setTimeout(() => el.textContent = '', 3000);
}

function showMainApp() {
    document.getElementById('authScreen').classList.add('hidden');
    document.getElementById('mainApp').classList.remove('hidden');
    
    const avatar = currentUser.avatar 
        ? `<img src="${currentUser.avatar}">` 
        : currentUser.username.charAt(0).toUpperCase();
    document.getElementById('myAvatar').innerHTML = avatar;
    document.getElementById('myUsername').textContent = currentUser.username;
    
    initSocket();
    initApp();
}

function initSocket() {
    socket = io(API_URL);
    
    socket.on('connect', () => {
        socket.emit('user_online', currentUser.id);
        socket.emit('get_chats', currentUser.id);
    });
    
    socket.on('chats_list', renderChats);
    
    socket.on('messages_history', ({ chatId, messages }) => {
        if (currentChat && currentChat.id === chatId) {
            renderMessages(messages);
        }
    });
    
    socket.on('new_message', (msg) => {
        if (currentChat && msg.chatId === currentChat.id) {
            appendMessage(msg);
        }
        socket.emit('get_chats', currentUser.id);
    });
    
    socket.on('message_edited', ({ chatId, messageId, newText }) => {
        if (currentChat && currentChat.id === chatId) {
            updateMessageText(messageId, newText);
        }
    });
    
    socket.on('message_deleted', ({ chatId, messageId }) => {
        if (currentChat && currentChat.id === chatId) {
            const el = document.querySelector(`[data-message-id="${messageId}"]`);
            if (el) el.remove();
        }
    });
    
    socket.on('reaction_added', ({ chatId, messageId, reactions }) => {
        if (currentChat && currentChat.id === chatId) {
            updateReactions(messageId, reactions);
        }
    });
    
    socket.on('group_created', () => socket.emit('get_chats', currentUser.id));
    socket.on('group_updated', () => socket.emit('get_chats', currentUser.id));
    
    socket.on('group_deleted', ({ groupId }) => {
        if (currentChat && currentChat.id === groupId) {
            closeChat();
        }
        socket.emit('get_chats', currentUser.id);
    });
    
    socket.on('removed_from_group', ({ groupId }) => {
        if (currentChat && currentChat.id === groupId) {
            closeChat();
        }
        socket.emit('get_chats', currentUser.id);
    });
    
    socket.on('group_name_updated', ({ groupId, newName }) => {
        if (currentChat && currentChat.id === groupId) {
            document.getElementById('chatName').textContent = newName;
        }
        socket.emit('get_chats', currentUser.id);
    });
    
    socket.on('chat_cleared', ({ chatId }) => {
        if (currentChat && currentChat.id === chatId) {
            document.getElementById('messagesArea').innerHTML = '';
        }
    });
    
    // Call events
    socket.on('incoming_call', ({ chatId, callerId, callType }) => {
        handleIncomingCall(chatId, callerId, callType);
    });
    
    socket.on('call_answered', ({ chatId, answererId }) => {
        console.log('Call answered by', answererId);
    });
    
    socket.on('call_ended', () => {
        endCall();
    });
    
    socket.on('webrtc_signal', async ({ from, signal }) => {
        if (!peerConnection) return;
        
        try {
            if (signal.offer) {
                await peerConnection.setRemoteDescription(new RTCSessionDescription(signal.offer));
                const answer = await peerConnection.createAnswer();
                await peerConnection.setLocalDescription(answer);
                socket.emit('webrtc_signal', {
                    to: from,
                    signal: { answer },
                    from: currentUser.id
                });
            } else if (signal.answer) {
                await peerConnection.setRemoteDescription(new RTCSessionDescription(signal.answer));
            } else if (signal.candidate) {
                await peerConnection.addIceCandidate(new RTCIceCandidate(signal.candidate));
            }
        } catch (error) {
            console.error('WebRTC error:', error);
        }
    });
}

function initApp() {
    document.getElementById('profileSection').addEventListener('click', () => openModal('settingsModal'));
    document.getElementById('searchUsersBtn').addEventListener('click', () => openModal('searchModal'));
    document.getElementById('userSearchInput').addEventListener('input', (e) => searchUsers(e.target.value));
    
    document.getElementById('createGroupBtn').addEventListener('click', () => {
        openModal('createGroupModal');
        loadAllUsers('membersList', 'memberSearch');
    });
    document.getElementById('memberSearch').addEventListener('input', (e) => filterList('membersList', e.target.value));
    document.getElementById('createGroupConfirmBtn').addEventListener('click', createGroup);
    
    document.getElementById('updateUsernameBtn').addEventListener('click', updateUsername);
    document.getElementById('updatePasswordBtn').addEventListener('click', updatePassword);
    document.getElementById('logoutBtn').addEventListener('click', logout);
    document.getElementById('deleteAccountBtn').addEventListener('click', deleteAccount);
    document.getElementById('avatarInput').addEventListener('change', (e) => uploadAvatar(e.target.files[0]));
    
    document.querySelectorAll('.theme-btn').forEach(btn => {
        btn.addEventListener('click', () => changeTheme(btn.dataset.theme));
    });
    
    document.getElementById('sendBtn').addEventListener('click', sendMessage);
    document.getElementById('messageInput').addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });
    document.getElementById('messageInput').addEventListener('input', (e) => {
        e.target.style.height = 'auto';
        e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
    });
    
    document.getElementById('attachBtn').addEventListener('click', () => document.getElementById('fileInput').click());
    document.getElementById('fileInput').addEventListener('change', (e) => handleFileUpload(e.target.files));
    
    document.getElementById('voiceBtn').addEventListener('click', startVoiceRecording);
    document.getElementById('stopRecordingBtn').addEventListener('click', stopVoiceRecording);
    
    document.getElementById('voiceCallBtn').addEventListener('click', () => startCall('audio'));
    document.getElementById('videoCallBtn').addEventListener('click', () => startCall('video'));
    document.getElementById('endCallBtn').addEventListener('click', endCall);
    document.getElementById('muteBtn').addEventListener('click', toggleMute);
    
    document.getElementById('chatMenuBtn').addEventListener('click', () => {
        openModal('chatMenuModal');
        updateChatMenu();
    });
    
    document.getElementById('clearChatBtn').addEventListener('click', clearChat);
    document.getElementById('deleteChatBtn').addEventListener('click', deleteChat);
    document.getElementById('blockUserBtn').addEventListener('click', blockUser);
    document.getElementById('unblockUserBtn').addEventListener('click', unblockUser);
    document.getElementById('leaveGroupBtn').addEventListener('click', leaveGroup);
    document.getElementById('deleteGroupBtn').addEventListener('click', deleteGroup);
    document.getElementById('renameGroupBtn').addEventListener('click', renameGroup);
    
    document.getElementById('addMembersBtn').addEventListener('click', () => {
        closeModal('chatMenuModal');
        openModal('addMembersModal');
        loadAllUsers('addMembersList', 'addMemberSearch', currentChat.memberIds);
    });
    document.getElementById('addMemberSearch').addEventListener('input', (e) => filterList('addMembersList', e.target.value));
    document.getElementById('addMembersConfirmBtn').addEventListener('click', addMembersToGroup);
    
    document.getElementById('removeMembersBtn').addEventListener('click', () => {
        closeModal('chatMenuModal');
        openModal('removeMembersModal');
        loadGroupMembers();
    });
    
    document.getElementById('backBtn').addEventListener('click', () => {
        document.getElementById('sidebar').classList.remove('hide-mobile');
        document.getElementById('chatArea').classList.remove('show-mobile');
    });
    
    document.getElementById('chatSearch').addEventListener('input', (e) => filterChats(e.target.value));
}

function renderChats(chats) {
    const list = document.getElementById('chatsList');
    list.innerHTML = '';
    
    chats.sort((a, b) => b.timestamp - a.timestamp);
    
    chats.forEach(chat => {
        const item = document.createElement('div');
        item.className = 'chat-item';
        if (currentChat && currentChat.id === chat.id) {
            item.classList.add('active');
        }
        
        const avatar = chat.avatar 
            ? `<img src="${chat.avatar}">` 
            : chat.name.charAt(0).toUpperCase();
        
        const memberInfo = chat.type === 'group' ? ` (${chat.members})` : '';
        
        item.innerHTML = `
            <div class="avatar">${avatar}</div>
            <div class="chat-info">
                <div class="chat-name">${chat.name}${memberInfo}</div>
                <div class="chat-preview">${chat.lastMessage || 'Нет сообщений'}</div>
            </div>
        `;
        
        item.addEventListener('click', () => openChat(chat));
        list.appendChild(item);
    });
}

function openChat(chat) {
    currentChat = chat;
    
    document.getElementById('emptyState').classList.add('hidden');
    document.getElementById('activeChatContainer').classList.remove('hidden');
    
    const avatar = chat.avatar 
        ? `<img src="${chat.avatar}">` 
        : chat.name.charAt(0).toUpperCase();
    
    document.getElementById('chatAvatar').innerHTML = avatar;
    
    let chatTitle = chat.name;
    if (chat.type === 'group' && chat.creatorId === currentUser.id) {
        chatTitle += '<span class="creator-badge">Админ</span>';
    }
    document.getElementById('chatName').innerHTML = chatTitle;
    
    document.getElementById('chatStatus').textContent = 
        chat.type === 'group' ? `${chat.members} участников` : 'Онлайн';
    
    socket.emit('get_messages', { chatId: chat.id, userId: currentUser.id });
    
    document.getElementById('sidebar').classList.add('hide-mobile');
    document.getElementById('chatArea').classList.add('show-mobile');
    
    document.querySelectorAll('.chat-item').forEach(item => item.classList.remove('active'));
}

function closeChat() {
    currentChat = null;
    document.getElementById('emptyState').classList.remove('hidden');
    document.getElementById('activeChatContainer').classList.add('hidden');
}

function renderMessages(messages) {
    const area = document.getElementById('messagesArea');
    area.innerHTML = '';
    messages.forEach(msg => appendMessage(msg));
    scrollToBottom();
}

function appendMessage(msg) {
    const area = document.getElementById('messagesArea');
    const msgEl = createMessageElement(msg);
    area.appendChild(msgEl);
    scrollToBottom();
}

function createMessageElement(msg) {
    const isMine = msg.senderId === currentUser.id;
    const div = document.createElement('div');
    div.className = `message ${isMine ? 'my-message' : ''}`;
    div.dataset.messageId = msg.id;
    
    const avatar = msg.senderAvatar 
        ? `<img src="${msg.senderAvatar}">` 
        : (msg.senderName ? msg.senderName.charAt(0).toUpperCase() : '?');
    
    let content = '';
    
    if (msg.type === 'image') {
        content = `
            ${msg.text ? `<div>${escapeHtml(msg.text)}</div>` : ''}
            <img src="${msg.fileUrl}" class="message-image" alt="Image">
        `;
    } else if (msg.type === 'video') {
        content = `
            ${msg.text ? `<div>${escapeHtml(msg.text)}</div>` : ''}
            <video src="${msg.fileUrl}" class="message-video" controls></video>
        `;
    } else if (msg.type === 'voice') {
        content = `
            <div>Голосовое сообщение</div>
            <audio src="${msg.fileUrl}" class="message-audio" controls></audio>
        `;
    } else if (msg.type === 'file') {
        content = `
            ${msg.text ? `<div>${escapeHtml(msg.text)}</div>` : ''}
            <div class="message-file">
                <span>${getFileIcon(msg.fileName)}</span>
                <a href="${msg.fileUrl}" download="${msg.fileName}">${msg.fileName} (${formatSize(msg.fileSize)})</a>
            </div>
        `;
    } else {
        content = `<div>${escapeHtml(msg.text)}</div>`;
    }
    
    const time = new Date(msg.timestamp).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
    const edited = msg.edited ? '<span class="message-edited-badge">(изменено)</span>' : '';
    
    const reactions = msg.reactions && msg.reactions.length > 0
        ? `<div class="reactions">${msg.reactions.map(r => `<span class="reaction">${r.emoji}</span>`).join('')}</div>`
        : '';
    
    const actions = isMine
        ? `<div class="message-actions">
            <button class="message-btn" onclick="addReaction('${msg.id}')">❤️</button>
            <button class="message-btn" onclick="editMessage('${msg.id}')">✏️</button>
            <button class="message-btn" onclick="deleteMessage('${msg.id}')">🗑️</button>
           </div>`
        : `<div class="message-actions">
            <button class="message-btn" onclick="addReaction('${msg.id}')">❤️</button>
           </div>`;
    
    const showSender = currentChat && currentChat.type === 'group' && !isMine;
    
    div.innerHTML = `
        <div class="message-avatar">${avatar}</div>
        <div class="message-wrapper">
            ${showSender ? `<div class="message-sender">${escapeHtml(msg.senderName)}</div>` : ''}
            <div class="message-content">
                ${content}
                <div class="message-time">${time}${edited}</div>
                ${reactions}
                ${actions}
            </div>
        </div>
    `;
    
    return div;
}

function sendMessage() {
    const input = document.getElementById('messageInput');
    const text = input.value.trim();
    
    if (!text || !currentChat) return;
    
    socket.emit('send_message', {
        chatId: currentChat.id,
        senderId: currentUser.id,
        text,
        type: 'text'
    });
    
    input.value = '';
    input.style.height = 'auto';
}

function editMessage(id) {
    const el = document.querySelector(`[data-message-id="${id}"]`);
    const contentDiv = el.querySelector('.message-content > div');
    const text = contentDiv.textContent;
    const newText = prompt('Редактировать:', text);
    if (newText && newText !== text) {
        socket.emit('edit_message', {
            messageId: id,
            chatId: currentChat.id,
            newText,
            userId: currentUser.id
        });
    }
}

function deleteMessage(id) {
    if (confirm('Удалить сообщение?')) {
        socket.emit('delete_message', {
            messageId: id,
            chatId: currentChat.id,
            userId: currentUser.id
        });
    }
}

function addReaction(id) {
    const emoji = prompt('Реакция:', '❤️');
    if (emoji) {
        socket.emit('add_reaction', {
            messageId: id,
            chatId: currentChat.id,
            userId: currentUser.id,
            emoji
        });
    }
}

function updateMessageText(messageId, newText) {
    const el = document.querySelector(`[data-message-id="${messageId}"]`);
    if (el) {
        const content = el.querySelector('.message-content > div');
        if (content) content.textContent = newText;
        
        const time = el.querySelector('.message-time');
        if (time && !time.innerHTML.includes('изменено')) {
            time.innerHTML += '<span class="message-edited-badge">(изменено)</span>';
        }
    }
}

function updateReactions(messageId, reactions) {
    const el = document.querySelector(`[data-message-id="${messageId}"]`);
    if (el) {
        let reactionsDiv = el.querySelector('.reactions');
        if (!reactionsDiv && reactions.length > 0) {
            reactionsDiv = document.createElement('div');
            reactionsDiv.className = 'reactions';
            el.querySelector('.message-content').appendChild(reactionsDiv);
        }
        if (reactionsDiv) {
            reactionsDiv.innerHTML = reactions.map(r => `<span class="reaction">${r.emoji}</span>`).join('');
        }
    }
}

async function handleFileUpload(files) {
    if (!files || files.length === 0 || !currentChat) return;
    
    for (let file of files) {
        if (file.size > 500 * 1024 * 1024) {
            alert('Файл больше 500 МБ');
            continue;
        }
        
        const formData = new FormData();
        formData.append('file', file);
        formData.append('type', 'files');
        
        try {
            const xhr = new XMLHttpRequest();
            
            xhr.addEventListener('load', () => {
                if (xhr.status === 200) {
                    const data = JSON.parse(xhr.responseText);
                    
                    let type = 'file';
                    if (file.type.startsWith('image/')) type = 'image';
                    else if (file.type.startsWith('video/')) type = 'video';
                    
                    socket.emit('send_message', {
                        chatId: currentChat.id,
                        senderId: currentUser.id,
                        text: '',
                        type,
                        fileUrl: data.path,
                        fileName: data.originalName,
                        fileSize: data.size
                    });
                } else {
                    alert('Ошибка загрузки');
                }
            });
            
            xhr.open('POST', `${API_URL}/api/upload`);
            xhr.send(formData);
        } catch (error) {
            alert('Ошибка загрузки');
        }
    }
    
    document.getElementById('fileInput').value = '';
}

async function startVoiceRecording() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
        audioChunks = [];
        
        mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) {
                audioChunks.push(e.data);
            }
        };
        
        mediaRecorder.onstop = async () => {
            const blob = new Blob(audioChunks, { type: 'audio/webm' });
            await uploadVoice(blob);
            stream.getTracks().forEach(t => t.stop());
        };
        
        mediaRecorder.start();
        recordingStartTime = Date.now();
        document.getElementById('recordingIndicator').classList.add('active');
        updateRecordingTime();
    } catch (error) {
        alert('Нет доступа к микрофону');
    }
}

function stopVoiceRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
        document.getElementById('recordingIndicator').classList.remove('active');
    }
}

function updateRecordingTime() {
    if (!recordingStartTime) return;
    
    const elapsed = Date.now() - recordingStartTime;
    const mins = Math.floor(elapsed / 60000);
    const secs = Math.floor((elapsed % 60000) / 1000);
    
    document.getElementById('recordingTime').textContent = 
        `${mins}:${secs.toString().padStart(2, '0')}`;
    
    if (mediaRecorder && mediaRecorder.state === 'recording') {
        setTimeout(updateRecordingTime, 1000);
    }
}

async function uploadVoice(blob) {
    const formData = new FormData();
    formData.append('file', blob, 'voice.webm');
    formData.append('type', 'voice');
    
    try {
        const response = await fetch(`${API_URL}/api/upload`, {
            method: 'POST',
            body: formData
        });
        
        const data = await response.json();
        
        socket.emit('send_message', {
            chatId: currentChat.id,
            senderId: currentUser.id,
            text: '',
            type: 'voice',
            fileUrl: data.path
        });
    } catch (error) {
        alert('Ошибка отправки');
    }
}

async function searchUsers(query) {
    if (!query) {
        document.getElementById('searchResults').innerHTML = '';
        return;
    }
    
    try {
        const response = await fetch(`${API_URL}/api/search?query=${encodeURIComponent(query)}&userId=${currentUser.id}`);
        const users = await response.json();
        
        const list = document.getElementById('searchResults');
        list.innerHTML = '';
        
        users.forEach(user => {
            const item = document.createElement('div');
            item.className = 'user-item';
            
            const avatar = user.avatar 
                ? `<img src="${user.avatar}">` 
                : user.username.charAt(0).toUpperCase();
            
            item.innerHTML = `
                <div class="user-item-info">
                    <div class="avatar" style="width: 48px; height: 48px; font-size: 20px;">${avatar}</div>
                    <div class="user-item-name">${user.username}</div>
                </div>
                <button class="btn btn-primary" onclick="startChatWith('${user.id}', '${escapeHtml(user.username)}')">Написать</button>
            `;
            
            list.appendChild(item);
        });
    } catch (error) {
        alert('Ошибка поиска');
    }
}

function startChatWith(userId, username) {
    const chatId = [currentUser.id, userId].sort().join('_');
    openChat({ id: chatId, type: 'private', name: username, avatar: null });
    closeModal('searchModal');
    document.getElementById('userSearchInput').value = '';
    document.getElementById('searchResults').innerHTML = '';
}

async function loadAllUsers(listId, searchId, excludeIds = []) {
    try {
        const response = await fetch(`${API_URL}/api/users/all?userId=${currentUser.id}`);
        const users = await response.json();
        
        const list = document.getElementById(listId);
        list.innerHTML = '';
        
        users.filter(u => !excludeIds.includes(u.id)).forEach(user => {
            const label = document.createElement('label');
            label.className = 'checkbox-label';
            
            const avatar = user.avatar 
                ? `<img src="${user.avatar}">` 
                : user.username.charAt(0).toUpperCase();
            
            label.innerHTML = `
                <input type="checkbox" value="${user.id}">
                <div class="avatar" style="width: 40px; height: 40px; font-size: 18px;">${avatar}</div>
                <div>${user.username}</div>
            `;
            
            list.appendChild(label);
        });
    } catch (error) {
        alert('Ошибка загрузки');
    }
}

async function loadGroupMembers() {
    if (!currentChat || currentChat.type !== 'group') return;
    
    const list = document.getElementById('removeMembersList');
    list.innerHTML = '';
    
    for (let memberId of currentChat.memberIds) {
        if (memberId === currentUser.id || memberId === currentChat.creatorId) continue;
        
        try {
            const response = await fetch(`${API_URL}/api/user/${memberId}`);
            const user = await response.json();
            
            const item = document.createElement('div');
            item.className = 'user-item';
            
            const avatar = user.avatar 
                ? `<img src="${user.avatar}">` 
                : user.username.charAt(0).toUpperCase();
            
            item.innerHTML = `
                <div class="user-item-info">
                    <div class="avatar" style="width: 48px; height: 48px; font-size: 20px;">${avatar}</div>
                    <div class="user-item-name">${user.username}</div>
                </div>
                <button class="btn btn-secondary" onclick="removeMember('${memberId}')" style="background: var(--danger); color: white;">Удалить</button>
            `;
            
            list.appendChild(item);
        } catch (error) {
            console.error('Error loading member:', error);
        }
    }
}

function filterList(listId, query) {
    const items = document.querySelectorAll(`#${listId} .checkbox-label`);
    items.forEach(item => {
        const text = item.textContent.toLowerCase();
        item.style.display = text.includes(query.toLowerCase()) ? 'flex' : 'none';
    });
}

function createGroup() {
    const name = document.getElementById('groupName').value.trim();
    if (!name) {
        alert('Введите название');
        return;
    }
    
    const checked = document.querySelectorAll('#membersList input:checked');
    const members = Array.from(checked).map(c => c.value);
    
    if (members.length === 0) {
        alert('Выберите участников');
        return;
    }
    
    socket.emit('create_group', {
        name,
        members,
        creatorId: currentUser.id,
        avatar: null
    });
    
    closeModal('createGroupModal');
    document.getElementById('groupName').value = '';
}

function addMembersToGroup() {
    const checked = document.querySelectorAll('#addMembersList input:checked');
    const newMembers = Array.from(checked).map(c => c.value);
    
    if (newMembers.length === 0) {
        alert('Выберите участников');
        return;
    }
    
    socket.emit('add_members_to_group', {
        groupId: currentChat.id,
        newMembers
    });
    
    closeModal('addMembersModal');
    alert('Участники добавлены');
}

function removeMember(memberId) {
    if (confirm('Удалить участника?')) {
        socket.emit('remove_member', {
            groupId: currentChat.id,
            memberId,
            requesterId: currentUser.id
        });
        closeModal('removeMembersModal');
    }
}

async function updateUsername() {
    const newUsername = document.getElementById('newUsername').value.trim();
    if (!newUsername) return;
    
    try {
        const response = await fetch(`${API_URL}/api/settings/username`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: currentUser.id, newUsername })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            currentUser.username = data.username;
            localStorage.setItem('user', JSON.stringify(currentUser));
            document.getElementById('myUsername').textContent = data.username;
            alert('Логин изменён');
            document.getElementById('newUsername').value = '';
        } else {
            alert(data.error);
        }
    } catch (error) {
        alert('Ошибка');
    }
}

async function updatePassword() {
    const newPassword = document.getElementById('newPassword').value;
    if (!newPassword || newPassword.length < 4) {
        alert('Пароль минимум 4 символа');
        return;
    }
    
    try {
        const response = await fetch(`${API_URL}/api/settings/password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: currentUser.id, newPassword })
        });
        
        if (response.ok) {
            alert('Пароль изменён');
            document.getElementById('newPassword').value = '';
        } else {
            alert('Ошибка');
        }
    } catch (error) {
        alert('Ошибка');
    }
}

async function uploadAvatar(file) {
    if (!file) return;
    
    const formData = new FormData();
    formData.append('file', file);
    formData.append('type', 'avatars');
    
    try {
        const response = await fetch(`${API_URL}/api/upload`, {
            method: 'POST',
            body: formData
        });
        
        const data = await response.json();
        
        const updateResponse = await fetch(`${API_URL}/api/settings/avatar`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: currentUser.id, avatar: data.path })
        });
        
        if (updateResponse.ok) {
            currentUser.avatar = data.path;
            localStorage.setItem('user', JSON.stringify(currentUser));
            document.getElementById('myAvatar').innerHTML = `<img src="${data.path}">`;
            alert('Аватар обновлён');
        }
    } catch (error) {
        alert('Ошибка загрузки');
    }
}

function logout() {
    if (confirm('Выйти?')) {
        localStorage.clear();
        location.reload();
    }
}

async function deleteAccount() {
    if (confirm('Удалить аккаунт? Это необратимо!')) {
        try {
            await fetch(`${API_URL}/api/account`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId: currentUser.id })
            });
            localStorage.clear();
            location.reload();
        } catch (error) {
            alert('Ошибка');
        }
    }
}

function updateChatMenu() {
    const isGroup = currentChat.type === 'group';
    const isCreator = isGroup && currentChat.creatorId === currentUser.id;
    
    document.getElementById('addMembersBtn').style.display = isGroup && isCreator ? 'block' : 'none';
    document.getElementById('removeMembersBtn').style.display = isGroup && isCreator ? 'block' : 'none';
    document.getElementById('clearChatBtn').style.display = isGroup && isCreator ? 'block' : (isGroup ? 'none' : 'block');
    document.getElementById('blockUserBtn').style.display = isGroup ? 'none' : 'block';
    document.getElementById('unblockUserBtn').style.display = isGroup ? 'none' : 'block';
    document.getElementById('leaveGroupBtn').style.display = isGroup ? 'block' : 'none';
    document.getElementById('deleteGroupBtn').style.display = isGroup && isCreator ? 'block' : 'none';
    document.getElementById('renameGroupBtn').style.display = isGroup && isCreator ? 'block' : 'none';
    document.getElementById('deleteChatBtn').style.display = isGroup ? 'none' : 'block';
    
    if (!isGroup) {
        const otherUserId = currentChat.id.split('_').find(id => id !== currentUser.id);
        socket.emit('check_blocked', { userId: currentUser.id, otherUserId }, (result) => {
            if (result.isBlocked) {
                document.getElementById('blockUserBtn').style.display = 'none';
                document.getElementById('unblockUserBtn').style.display = 'block';
            } else {
                document.getElementById('blockUserBtn').style.display = 'block';
                document.getElementById('unblockUserBtn').style.display = 'none';
            }
        });
    }
}

function clearChat() {
    if (confirm('Очистить историю?')) {
        socket.emit('clear_chat', {
            chatId: currentChat.id,
            userId: currentUser.id
        });
        closeModal('chatMenuModal');
    }
}

function deleteChat() {
    if (confirm('Удалить чат?')) {
        socket.emit('delete_chat', {
            chatId: currentChat.id,
            userId: currentUser.id
        });
        closeChat();
        closeModal('chatMenuModal');
    }
}

function blockUser() {
    if (confirm('Заблокировать?')) {
        const userId = currentChat.id.split('_').find(id => id !== currentUser.id);
        socket.emit('block_user', {
            userId: currentUser.id,
            blockedUserId: userId
        });
        closeModal('chatMenuModal');
        alert('Заблокирован');
    }
}

function unblockUser() {
    if (confirm('Разблокировать?')) {
        const userId = currentChat.id.split('_').find(id => id !== currentUser.id);
        socket.emit('unblock_user', {
            userId: currentUser.id,
            blockedUserId: userId
        });
        closeModal('chatMenuModal');
        alert('Разблокирован');
    }
}

function leaveGroup() {
    if (confirm('Покинуть группу?')) {
        socket.emit('leave_group', {
            groupId: currentChat.id,
            userId: currentUser.id
        });
        closeChat();
        closeModal('chatMenuModal');
    }
}

function deleteGroup() {
    if (confirm('Удалить группу?')) {
        socket.emit('delete_group', {
            groupId: currentChat.id,
            userId: currentUser.id
        });
        closeChat();
        closeModal('chatMenuModal');
    }
}

function renameGroup() {
    const newName = prompt('Новое название:', currentChat.name);
    if (newName && newName !== currentChat.name) {
        socket.emit('update_group_name', {
            groupId: currentChat.id,
            newName,
            userId: currentUser.id
        });
        closeModal('chatMenuModal');
    }
}

async function startCall(type) {
    if (!currentChat) return;
    
    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: type === 'video'
        });
        
        document.getElementById('localVideo').srcObject = localStream;
        if (type === 'audio') {
            document.getElementById('callVideos').style.display = 'none';
        } else {
            document.getElementById('callVideos').style.display = 'flex';
        }
        
        peerConnection = new RTCPeerConnection(iceServers);
        
        localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, localStream);
        });
        
        peerConnection.ontrack = (event) => {
            remoteStream = event.streams[0];
            document.getElementById('remoteVideo').srcObject = remoteStream;
        };
        
        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                const otherUserId = getOtherUserId();
                if (otherUserId) {
                    socket.emit('webrtc_signal', {
                        to: otherUserId,
                        signal: { candidate: event.candidate },
                        from: currentUser.id
                    });
                }
            }
        };
        
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        
        socket.emit('start_call', {
            chatId: currentChat.id,
            callerId: currentUser.id,
            callType: type
        });
        
        const otherUserId = getOtherUserId();
        if (otherUserId) {
            socket.emit('webrtc_signal', {
                to: otherUserId,
                signal: { offer },
                from: currentUser.id
            });
        }
        
        document.getElementById('callOverlay').classList.add('active');
        document.getElementById('callName').textContent = currentChat.name;
        document.getElementById('callStatus').textContent = 'Звонок...';
        inCall = true;
    } catch (error) {
        alert('Ошибка доступа к камере/микрофону');
    }
}

async function handleIncomingCall(chatId, callerId, callType) {
    if (!confirm('Входящий звонок. Ответить?')) return;
    
    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: callType === 'video'
        });
        
        document.getElementById('localVideo').srcObject = localStream;
        if (callType === 'audio') {
            document.getElementById('callVideos').style.display = 'none';
        } else {
            document.getElementById('callVideos').style.display = 'flex';
        }
        
        peerConnection = new RTCPeerConnection(iceServers);
        
        localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, localStream);
        });
        
        peerConnection.ontrack = (event) => {
            remoteStream = event.streams[0];
            document.getElementById('remoteVideo').srcObject = remoteStream;
        };
        
        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                socket.emit('webrtc_signal', {
                    to: callerId,
                    signal: { candidate: event.candidate },
                    from: currentUser.id
                });
            }
        };
        
        socket.emit('answer_call', {
            chatId,
            answererId: currentUser.id
        });
        
        document.getElementById('callOverlay').classList.add('active');
        document.getElementById('callName').textContent = 'Звонок';
        document.getElementById('callStatus').textContent = 'Соединение...';
        inCall = true;
    } catch (error) {
        alert('Ошибка доступа к камере/микрофону');
    }
}

function endCall() {
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    
    if (remoteStream) {
        remoteStream = null;
    }
    
    document.getElementById('callOverlay').classList.remove('active');
    document.getElementById('localVideo').srcObject = null;
    document.getElementById('remoteVideo').srcObject = null;
    
    if (inCall && currentChat) {
        socket.emit('end_call', { chatId: currentChat.id });
    }
    
    inCall = false;
}

function toggleMute() {
    if (!localStream) return;
    
    const audioTrack = localStream.getAudioTracks()[0];
    if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        document.getElementById('muteBtn').textContent = audioTrack.enabled ? '🔇' : '🔊';
    }
}

function getOtherUserId() {
    if (!currentChat) return null;
    if (currentChat.type === 'group') return null;
    return currentChat.id.split('_').find(id => id !== currentUser.id);
}

function initTheme() {
    const theme = localStorage.getItem('theme') || 'light';
    document.body.dataset.theme = theme;
    updateThemeButtons(theme);
}

function changeTheme(theme) {
    document.body.dataset.theme = theme;
    localStorage.setItem('theme', theme);
    updateThemeButtons(theme);
    
    if (currentUser) {
        fetch(`${API_URL}/api/settings/theme`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: currentUser.id, theme })
        });
    }
}

function updateThemeButtons(theme) {
    document.querySelectorAll('.theme-btn').forEach(btn => {
        if (btn.dataset.theme === theme) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });
}

function openModal(id) {
    document.getElementById(id).classList.add('active');
}

function closeModal(id) {
    document.getElementById(id).classList.remove('active');
}

function scrollToBottom() {
    const area = document.getElementById('messagesArea');
    area.scrollTop = area.scrollHeight;
}

function filterChats(query) {
    document.querySelectorAll('.chat-item').forEach(item => {
        const name = item.querySelector('.chat-name').textContent.toLowerCase();
        item.style.display = name.includes(query.toLowerCase()) ? 'flex' : 'none';
    });
}

function escapeHtml(text) {
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, m => map[m]);
}

function getFileIcon(name) {
    const ext = name.split('.').pop().toLowerCase();
    const icons = {
        pdf: '📄', doc: '📝', docx: '📝', xls: '📊', xlsx: '📊',
        zip: '📦', rar: '📦', mp3: '🎵', wav: '🎵'
    };
    return icons[ext] || '📎';
}

function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}
