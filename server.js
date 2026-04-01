const express = require('express');
const http = require('http');
const socketIO = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

// 配置静态文件根目录
app.use(express.static(__dirname));

// 房间数据结构
const rooms = {};

// 生成6位全大写字母的唯一房间号
function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
  } while (rooms[code]);
  return code;
}

// 监听WebSocket连接事件
io.on('connection', (socket) => {
  console.log('客户端已连接:', socket.id);
  
  // 创建房间
  socket.on('create_room', (data, callback) => {
    const { roomName, timeLimit, targetPlayers } = data;
    const roomCode = generateRoomCode();
    
    // 创建房间对象
    rooms[roomCode] = {
      name: roomName,
      timeLimit: timeLimit,
      targetPlayers: targetPlayers,
      students: [],
      choices: {}, // socket.id -> choice
      status: 'waiting', // waiting, playing, ended
      createdAt: new Date(),
      teacherSocketId: socket.id,
      timer: null
    };
    
    console.log(`房间创建成功: ${roomCode} - ${roomName}`);
    callback({ success: true, roomCode });
  });
  
  // 加入房间
  socket.on('join_room', (data, callback) => {
    const { roomCode, nickname } = data;
    
    // 检查房间是否存在
    if (!rooms[roomCode]) {
      callback({ success: false, error: '房间不存在' });
      return;
    }
    
    const room = rooms[roomCode];
    
    // 检查房间人数是否已满
    if (room.students.length >= room.targetPlayers) {
      callback({ success: false, error: '房间已满' });
      return;
    }
    
    // 检查昵称是否已存在
    if (room.students.some(student => student.nickname === nickname)) {
      callback({ success: false, error: '昵称已存在' });
      return;
    }
    
    // 添加学生信息
    const student = {
      id: socket.id,
      nickname: nickname || `匿名${Math.floor(Math.random() * 1000)}`
    };
    
    room.students.push(student);
    socket.join(roomCode);
    
    console.log(`学生加入房间: ${roomCode} - ${student.nickname}`);
    
    // 向学生返回成功
    callback({ success: true });
    
    // 向教师端发送学生加入事件
    io.to(room.teacherSocketId).emit('player_joined', student);
  });
  
  // 提交选择
  socket.on('submit_choice', (data, callback) => {
    const { roomCode, choice } = data;
    
    if (!rooms[roomCode]) {
      callback({ success: false, error: '房间不存在' });
      return;
    }
    
    const room = rooms[roomCode];
    
    if (room.status !== 'playing') {
      callback({ success: false, error: '游戏未开始或已结束' });
      return;
    }
    
    // 检查是否已经提交过选择
    if (room.choices[socket.id]) {
      callback({ success: false, error: '已提交过选择' });
      return;
    }
    
    // 验证选择是否有效
    if (choice !== 'cooperate' && choice !== 'betray') {
      callback({ success: false, error: '无效的选择' });
      return;
    }
    
    // 记录选择
    room.choices[socket.id] = choice;
    
    console.log(`学生提交选择: ${roomCode} - ${socket.id} - ${choice}`);
    
    // 计算当前统计数据
    const totalPlayers = room.students.length;
    let cooperateCount = 0;
    let betrayCount = 0;
    
    for (const c of Object.values(room.choices)) {
      if (c === 'cooperate') {
        cooperateCount++;
      } else {
        betrayCount++;
      }
    }
    
    // 向教师端发送更新数据
    io.to(room.teacherSocketId).emit('update_dashboard', {
      totalPlayers: Object.keys(room.choices).length,
      cooperateCount: cooperateCount,
      betrayCount: betrayCount
    });
    
    // 向学生返回成功响应
    callback({ success: true });
  });
  
  // 开始游戏
  socket.on('start_game', (data, callback) => {
    const { roomCode } = data;
    
    if (!rooms[roomCode]) {
      callback({ success: false, error: '房间不存在' });
      return;
    }
    
    const room = rooms[roomCode];
    
    if (room.status !== 'waiting') {
      callback({ success: false, error: '游戏已经开始' });
      return;
    }
    
    // 更新房间状态
    room.status = 'playing';
    
    console.log(`游戏开始: ${roomCode} - ${room.name}`);
    
    // 向房间内所有客户端广播游戏开始事件
    io.to(roomCode).emit('game_started', {
      timeLimit: room.timeLimit
    });
    
    // 向教师端发送成功响应
    callback({ success: true });
    
    // 开始倒计时
    let timeRemaining = room.timeLimit;
    room.timer = setInterval(() => {
      timeRemaining--;
      
      // 向房间内所有客户端广播倒计时
      io.to(roomCode).emit('update_timer', {
        timeRemaining: timeRemaining
      });
      
      if (timeRemaining <= 0) {
        clearInterval(room.timer);
        room.timer = null;
        
        // 自动结束游戏
        endGame(roomCode);
      }
    }, 1000);
  });
  
  // 结束游戏
  socket.on('stop_game', (data, callback) => {
    const { roomCode } = data;
    
    if (!rooms[roomCode]) {
      callback({ success: false, error: '房间不存在' });
      return;
    }
    
    const room = rooms[roomCode];
    
    if (room.status !== 'playing') {
      callback({ success: false, error: '游戏未开始' });
      return;
    }
    
    // 结束游戏
    endGame(roomCode);
    
    // 向教师端发送成功响应
    callback({ success: true });
  });
  
  // 监听客户端断开连接事件
  socket.on('disconnect', () => {
    console.log('客户端已断开连接:', socket.id);
    
    // 清理断开连接的学生
    for (const roomCode in rooms) {
      const room = rooms[roomCode];
      const studentIndex = room.students.findIndex(s => s.id === socket.id);
      if (studentIndex !== -1) {
        const student = room.students[studentIndex];
        room.students.splice(studentIndex, 1);
        console.log(`学生离开房间: ${roomCode} - ${student.nickname}`);
        
        // 向教师端发送学生离开事件
        io.to(room.teacherSocketId).emit('player_left', student);
        break;
      }
    }
  });
});

// 结束游戏函数
function endGame(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  
  // 停止计时器
  if (room.timer) {
    clearInterval(room.timer);
    room.timer = null;
  }
  
  // 更新房间状态
  room.status = 'ended';
  
  console.log(`游戏结束: ${roomCode} - ${room.name}`);
  
  // 向房间内所有客户端广播游戏结束事件
  io.to(roomCode).emit('game_ended');
  
  // 计算游戏结果
  calculateResults(roomCode);
}

// 计算游戏结果
function calculateResults(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  
  const choices = room.choices;
  const totalPlayers = room.students.length;
  
  // 计算合作和背叛的人数
  let cooperateCount = 0;
  let betrayCount = 0;
  
  for (const choice of Object.values(choices)) {
    if (choice === 'cooperate') {
      cooperateCount++;
    } else {
      betrayCount++;
    }
  }
  
  // 为未提交选择的学生默认为背叛
  for (const student of room.students) {
    if (!choices[student.id]) {
      choices[student.id] = 'betray';
      betrayCount++;
    }
  }
  
  // 计算每个学生的得分
  for (const student of room.students) {
    const studentChoice = choices[student.id] || 'betray';
    let score = 0;
    
    if (studentChoice === 'cooperate') {
      // 合作的得分 = 3 * 合作率 + 0 * 背叛率
      score = Math.round(3 * (cooperateCount / totalPlayers) + 0 * (betrayCount / totalPlayers));
    } else {
      // 背叛的得分 = 5 * 合作率 + 1 * 背叛率
      score = Math.round(5 * (cooperateCount / totalPlayers) + 1 * (betrayCount / totalPlayers));
    }
    
    // 向学生发送个人得分
    io.to(student.id).emit('game_result', {
      score: score,
      choice: studentChoice,
      cooperateCount: cooperateCount,
      betrayCount: betrayCount
    });
  }
  
  // 向教师端发送统计数据
  io.to(room.teacherSocketId).emit('update_dashboard', {
    totalPlayers: totalPlayers,
    cooperateCount: cooperateCount,
    betrayCount: betrayCount
  });
}

// 启动服务器
const PORT = 3000;
server.listen(PORT, () => {
  console.log(`服务器运行在 http://localhost:${PORT}`);
});