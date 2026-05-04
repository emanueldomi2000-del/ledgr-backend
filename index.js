

const express = require('express')
const cors = require('cors')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const { PrismaClient } = require('@prisma/client')
require('dotenv').config()

const app = express()
const prisma = new PrismaClient()

app.use(cors())
app.use(express.json())

// TEST ROUTE
app.get('/', (req, res) => {
  res.json({ message: 'LEDGR API is live! 🔥' })
})

// REGISTER
app.post('/auth/register', async (req, res) => {
  try {
    const { email, username, password } = req.body
    const hashed = await bcrypt.hash(password, 10)
    const user = await prisma.user.create({
      data: { email, username, password: hashed }
    })
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET)
    res.json({ token, user: { id: user.id, email, username } })
  } catch (err) {
    res.status(400).json({ error: 'User already exists' })
  }
})

// LOGIN
app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body
    const user = await prisma.user.findUnique({ where: { email } })
    if (!user) return res.status(400).json({ error: 'User not found' })
    const valid = await bcrypt.compare(password, user.password)
    if (!valid) return res.status(400).json({ error: 'Wrong password' })
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET)
    res.json({ token, user: { id: user.id, email, username: user.username } })
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

// GET ALL PICKS
app.get('/picks', async (req, res) => {
  const picks = await prisma.pick.findMany({
    include: { user: { select: { username: true } } },
    orderBy: { createdAt: 'desc' }
  })
  res.json(picks)
})

// ADD PICK
app.post('/picks', async (req, res) => {
  try {
    const { userId, sport, event, market, odds, stake, result, pnl } = req.body
    const pick = await prisma.pick.create({
      data: { userId, sport, event, market, odds, stake, result, pnl }
    })
    res.json(pick)
  } catch (err) {
    res.status(500).json({ error: 'Server error' })
  }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`LEDGR API running on port ${PORT} 🚀`)
})
 
