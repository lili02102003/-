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
      timer: null,
      totalRounds: data.totalRounds || 1, // 总轮数
      currentRound: 1, // 当前轮次
      history: [], // 每轮的统计数据历史
      playerScores: {} // 玩家总积分
    };
    
    console.log(`房间创建成功: ${roomCode} - ${roomName}`);
    socket.join(roomCode);
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
    const { roomCode, totalRounds } = data;
    
    if (!rooms[roomCode]) {
      callback({ success: false, error: '房间不存在' });
      return;
    }
    
    const room = rooms[roomCode];
    
    if (room.status !== 'waiting') {
      callback({ success: false, error: '游戏已经开始' });
      return;
    }
    
    // 更新房间状态和轮数信息
    room.status = 'playing';
    if (totalRounds) {
      room.totalRounds = totalRounds;
    }
    // 绝不能在这里重置 room.currentRound = 1，否则会导致多轮博弈无法推进
    
    console.log(`游戏开始: ${roomCode} - ${room.name}, 共${room.totalRounds}轮`);
    
    // 向房间内所有客户端广播游戏开始事件
    io.to(roomCode).emit('game_started', {
      timeLimit: room.timeLimit,
      totalRounds: room.totalRounds,
      currentRound: room.currentRound
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
  
  // 重置新一轮游戏
  socket.on('reset_round', (data, callback) => {
    const { roomCode } = data;
    
    if (!rooms[roomCode]) {
      callback({ success: false, error: '房间不存在' });
      return;
    }
    
    const room = rooms[roomCode];
    
    // 清空选择记录
    room.choices = {};
    
    // 深度重置游戏状态与历史数据
    room.status = 'waiting';
    room.currentRound = 1;
    room.history = [];
    room.playerScores = {};
    
    // 停止计时器（如果正在运行）
    if (room.timer) {
      clearInterval(room.timer);
      room.timer = null;
    }
    
    console.log(`游戏重置: ${roomCode} - ${room.name}`);
    
    // 向房间内所有客户端广播游戏重置事件
    io.to(roomCode).emit('room_reset');
    
    // 向教师端发送成功响应
    callback({ success: true });
  });
  
  // 进入下一轮
  socket.on('next_round', (data, callback) => {
    const { roomCode } = data;
    
    if (!rooms[roomCode]) {
      callback({ success: false, error: '房间不存在' });
      return;
    }
    
    const room = rooms[roomCode];
    
    // 检查是否还有轮次
    if (room.currentRound >= room.totalRounds) {
      callback({ success: false, error: '已达到最大轮次' });
      return;
    }
    
    // 增加轮次
    room.currentRound++;
    
    // 清空选择记录
    room.choices = {};
    
    // 重置游戏状态
    room.status = 'waiting';
    
    // 停止计时器（如果正在运行）
    if (room.timer) {
      clearInterval(room.timer);
      room.timer = null;
    }
    
    console.log(`进入下一轮: ${roomCode} - 第${room.currentRound}/${room.totalRounds}轮`);
    
    // 向房间内所有客户端广播进入下一轮事件
    io.to(roomCode).emit('next_round', {
      currentRound: room.currentRound,
      totalRounds: room.totalRounds
    });
    
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
        
        // 删除该学生的选择记录
        if (room.choices[socket.id]) {
          delete room.choices[socket.id];
        }
        
        // 向教师端发送学生离开事件
        io.to(room.teacherSocketId).emit('player_left', student);
        
        // 重新计算并发送更新数据
        const actualPlayers = Object.keys(room.choices).length;
        let cooperateCount = 0;
        
        for (const choice of Object.values(room.choices)) {
          if (choice === 'cooperate') {
            cooperateCount++;
          }
        }
        
        const betrayCount = actualPlayers - cooperateCount;
        
        // 向教师端发送更新数据
        io.to(room.teacherSocketId).emit('update_dashboard', {
          totalPlayers: actualPlayers,
          cooperateCount: cooperateCount,
          betrayCount: betrayCount
        });
        
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
  
  // 计算游戏结果
  calculateResults(roomCode);
}

// 洗牌算法
function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

// 计算游戏结果
function calculateResults(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  
  const choices = room.choices;
  
  // 为未提交选择的学生默认为背叛
  for (const student of room.students) {
    if (!choices[student.id]) {
      choices[student.id] = 'betray';
    }
  }
  
  // 获取已提交选择的玩家
  const activePlayers = room.students.filter(student => choices[student.id]);
  const actualPlayers = activePlayers.length;
  
  // 初始化统计数据
  let ccCount = 0; // 双人合作组数
  let bbCount = 0; // 双人背叛组数
  let cbCount = 0; // 一人合作一人背叛组数
  
  // 洗牌算法随机打乱玩家顺序
  const shuffledPlayers = shuffleArray([...activePlayers]);
  
  // 两两分组
  for (let i = 0; i < shuffledPlayers.length; i += 2) {
    if (i + 1 < shuffledPlayers.length) {
      // 正常两人分组
      const player1 = shuffledPlayers[i];
      const player2 = shuffledPlayers[i + 1];
      
      const choice1 = choices[player1.id];
      const choice2 = choices[player2.id];
      
      let score1, score2;
      
      // 经典2人博弈矩阵计分
      if (choice1 === 'cooperate' && choice2 === 'cooperate') {
        score1 = 3;
        score2 = 3;
        ccCount++;
      } else if (choice1 === 'betray' && choice2 === 'betray') {
        score1 = 1;
        score2 = 1;
        bbCount++;
      } else {
        if (choice1 === 'betray') {
          score1 = 5;
          score2 = 0;
        } else {
          score1 = 0;
          score2 = 5;
        }
        cbCount++;
      }
      
      // 更新玩家总积分
      room.playerScores[player1.id] = (room.playerScores[player1.id] || 0) + score1;
      room.playerScores[player2.id] = (room.playerScores[player2.id] || 0) + score2;
      
      // 向玩家发送结果
      io.to(player1.id).emit('game_result', {
        score: score1,
        choice: choice1,
        opponentChoice: choice2,
        isBotMatch: false,
        totalScore: room.playerScores[player1.id]
      });
      
      io.to(player2.id).emit('game_result', {
        score: score2,
        choice: choice2,
        opponentChoice: choice1,
        isBotMatch: false,
        totalScore: room.playerScores[player2.id]
      });
    } else {
      // 奇数玩家情况，匹配虚拟对手
      const player = shuffledPlayers[i];
      const choice = choices[player.id];
      let score;
      
      // 虚拟对手默认选择合作
      if (choice === 'cooperate') {
        score = 3;
      } else {
        score = 5;
      }
      
      // 更新玩家总积分
      room.playerScores[player.id] = (room.playerScores[player.id] || 0) + score;
      
      // 向玩家发送结果
      io.to(player.id).emit('game_result', {
        score: score,
        choice: choice,
        opponentChoice: 'cooperate',
        isBotMatch: true,
        totalScore: room.playerScores[player.id]
      });
    }
  }
  
  // 构建本轮统计数据
  const roundData = {
    round: room.currentRound,
    ccCount: ccCount,
    bbCount: bbCount,
    cbCount: cbCount,
    totalPlayers: actualPlayers
  };
  
  // 添加到历史记录
  room.history.push(roundData);
  
  // 向教师端发送统计数据
  io.to(room.teacherSocketId).emit('update_dashboard', {
    totalPlayers: actualPlayers,
    ccCount: ccCount,
    bbCount: bbCount,
    cbCount: cbCount,
    currentRound: room.currentRound,
    totalRounds: room.totalRounds
  });
  
  // 向教师端发送游戏结束事件，包含统计数据
  io.to(room.teacherSocketId).emit('game_ended', {
    ...roundData,
    currentRound: room.currentRound,
    totalRounds: room.totalRounds,
    history: room.history
  });
}

// 启动服务器
const PORT = 3000;
server.listen(PORT, () => {
  console.log(`服务器运行在 http://localhost:${PORT}`);
});