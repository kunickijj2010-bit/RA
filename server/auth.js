const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'refunds_secret_jwt_key_123';

// Generate JWT token for an authenticated user
function generateToken(user) {
  return jwt.sign(
    { 
      id: user.id, 
      username: user.username, 
      role: user.role,
      full_name: user.full_name,
      email: user.email,
      rocketchat_username: user.rocketchat_username
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

// Middleware to authenticate token from Authorization header
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: "Требуется авторизация." });
  }

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(401).json({ error: "Сессия устарела или недействительна. Войдите заново." });
    }
    req.user = decoded;
    next();
  });
}

// Middleware to ensure the authenticated user is an Admin
function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: "Требуется авторизация." });
  }
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: "Доступ запрещен. Требуются права администратора." });
  }
  next();
}

module.exports = {
  generateToken,
  authenticateToken,
  requireAdmin,
  JWT_SECRET
};
