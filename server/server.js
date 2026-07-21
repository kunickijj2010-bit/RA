const express = require('express');
const cors = require('cors');
const path = require('path');
// Load env configuration
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { db, initDb } = require('./database');
const { notifyStatusChange, syncToGoogleSheets } = require('./notifications');
const { getSettings, saveSettings } = require('./settings_manager');
const bcrypt = require('bcryptjs');
const { generateToken, authenticateToken, requireAdmin } = require('./auth');
const { run: runImport, cleanOperatorName } = require('./import_sheets');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// Serve static files from the React frontend build folder
app.use(express.static(path.join(__dirname, 'public')));

// Helper to get all validators from Supabase dynamically
async function getValidatorsFromDb() {
  const { data, error } = await db
    .from('validators')
    .select('code, system_type')
    .order('code', { ascending: true });
    
  if (error) throw error;
  return data;
}

// --- Authentication & User Management Endpoints ---

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "Логин и пароль обязательны." });
  }

  try {
    const { data: user, error } = await db
      .from('users')
      .select('*')
      .eq('username', username.toLowerCase().trim())
      .single();

    if (error || !user) {
      return res.status(401).json({ error: "Неверный логин или пароль." });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: "Неверный логин или пароль." });
    }

    const token = generateToken(user);
    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        full_name: user.full_name,
        email: user.email,
        rocketchat_username: user.rocketchat_username,
        role: user.role
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/me
app.get('/api/auth/me', authenticateToken, async (req, res) => {
  res.json({ user: req.user });
});

// GET /api/users (Admin only)
app.get('/api/users', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { data: users, error } = await db
      .from('users')
      .select('id, username, full_name, email, rocketchat_username, role, created_at')
      .order('id', { ascending: true });

    if (error) throw error;
    res.json(users || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/users (Admin only)
app.post('/api/users', authenticateToken, requireAdmin, async (req, res) => {
  const { username, password, full_name, email, rocketchat_username, role } = req.body;

  if (!username || !password || !full_name || !role) {
    return res.status(400).json({ error: "Пожалуйста, заполните все обязательные поля." });
  }

  try {
    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(password, salt);

    const { data: newUser, error } = await db
      .from('users')
      .insert([
        {
          username: username.toLowerCase().trim(),
          password_hash,
          full_name: full_name.trim(),
          email: email || null,
          rocketchat_username: rocketchat_username || null,
          role
        }
      ])
      .select('id, username, full_name, email, rocketchat_username, role')
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(400).json({ error: "Пользователь с таким логином уже существует." });
      }
      throw error;
    }

    res.status(201).json(newUser);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/users/:id (Admin only)
app.put('/api/users/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { username, password, full_name, email, rocketchat_username, role } = req.body;

  if (!username || !full_name || !role) {
    return res.status(400).json({ error: "Пожалуйста, заполните все обязательные поля." });
  }

  try {
    // Fetch old user data before update (to detect name change)
    const { data: oldUser } = await db
      .from('users')
      .select('full_name, rocketchat_username')
      .eq('id', id)
      .single();

    const newFullName = full_name.trim();

    const updateData = {
      username: username.toLowerCase().trim(),
      full_name: newFullName,
      email: email || null,
      rocketchat_username: rocketchat_username || null,
      role,
      updated_at: new Date().toISOString()
    };

    if (password) {
      const salt = await bcrypt.genSalt(10);
      updateData.password_hash = await bcrypt.hash(password, salt);
    }

    const { data: updatedUser, error } = await db
      .from('users')
      .update(updateData)
      .eq('id', id)
      .select('id, username, full_name, email, rocketchat_username, role')
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(400).json({ error: "Пользователь с таким логином уже существует." });
      }
      throw error;
    }

    // Auto-reassociate RAs when full_name changes
    if (oldUser && oldUser.full_name !== newFullName) {
      const oldSurname = oldUser.full_name ? oldUser.full_name.split(' ')[0] : null;
      const raUpdateData = { requested_by: newFullName };
      if (rocketchat_username) {
        raUpdateData.operator_rocketchat = rocketchat_username;
      }

      // Update RAs matching old full name
      await db.from('refund_applications')
        .update(raUpdateData)
        .eq('requested_by', oldUser.full_name);

      // Update RAs matching old surname (if different from old full name)
      if (oldSurname && oldSurname !== oldUser.full_name) {
        await db.from('refund_applications')
          .update(raUpdateData)
          .eq('requested_by', oldSurname);
      }

      // Update status_history
      await db.from('status_history')
        .update({ changed_by: newFullName })
        .eq('changed_by', oldUser.full_name);
      if (oldSurname && oldSurname !== oldUser.full_name) {
        await db.from('status_history')
          .update({ changed_by: newFullName })
          .eq('changed_by', oldSurname);
      }

      console.log(`📝 Auto-reassociated RAs: "${oldUser.full_name}" → "${newFullName}"`);
    }

    res.json(updatedUser);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/users/:id (Admin only)
app.delete('/api/users/:id', authenticateToken, requireAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    if (parseInt(id) === req.user.id) {
      return res.status(400).json({ error: "Вы не можете удалить свою собственную учетную запись." });
    }

    const { error } = await db
      .from('users')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.json({ success: true, message: "Пользователь успешно удален." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Helper to apply filters to a Supabase query
function applyFilters(query, req) {
  const search = req.query.search || '';
  const status = req.query.status || '';
  const systemType = req.query.system_type || '';
  const validator = req.query.validator || '';
  const dateStart = req.query.date_start || '';
  const dateEnd = req.query.date_end || '';
  const onlyMine = req.query.only_mine === 'true';

  if (onlyMine && req.user) {
    const fullName = req.user.full_name;
    const surname = fullName.split(' ')[0];
    if (fullName !== surname) {
      // Match by full name OR surname-only (for legacy data)
      query = query.or(`requested_by.eq.${fullName},requested_by.eq.${surname}`);
    } else {
      query = query.eq('requested_by', fullName);
    }
  }

  if (search) {
    const cleanSearch = search.replace(/"/g, '\\"');
    const digitsOnly = search.replace(/\D/g, '');
    
    const conditions = [
      `ticket_number.ilike."%${cleanSearch}%"`,
      `bsp_request_number.ilike."%${cleanSearch}%"`,
      `tch_request_number.ilike."%${cleanSearch}%"`,
      `agent_name.ilike."%${cleanSearch}%"`,
      `requested_by.ilike."%${cleanSearch}%"`,
      `validator.ilike."%${cleanSearch}%"`
    ];
    
    // If search term contains digits with dashes/spaces, also search for the clean digit string
    if (digitsOnly && digitsOnly.length >= 3 && digitsOnly !== cleanSearch) {
      conditions.push(`ticket_number.ilike."%${digitsOnly}%"`);
    }
    
    query = query.or(conditions.join(','));
  }

  if (status) {
    if (status.includes(',')) {
      const statuses = status.split(',').map(s => s.trim()).filter(Boolean);
      if (statuses.length > 0) {
        query = query.in('status', statuses);
      }
    } else {
      query = query.eq('status', status);
    }
  }
  if (systemType) query = query.eq('system_type', systemType);
  if (validator) query = query.eq('validator', validator);

  if (dateStart) query = query.gte('request_date', dateStart);
  if (dateEnd) query = query.lte('request_date', dateEnd);

  return query;
}

// 1. GET /api/refunds - Filtered list of refunds with server-side pagination, search, and warning check
app.get('/api/refunds', authenticateToken, async (req, res) => {
  const page = parseInt(req.query.page || '1');
  const limit = parseInt(req.query.limit || '10');
  const offset = (page - 1) * limit;

  const onlyWarnings = req.query.only_warnings === 'true';
  const onlyPending = req.query.only_pending === 'true';
  const archiveStatus = req.query.archive_status || 'active'; // 'active', 'archived', 'all'

  try {
    let query = db.from('refund_applications').select('*', { count: 'exact' });

    // Archive status filter
    if (archiveStatus === 'active') {
      query = query.eq('is_archived', false);
    } else if (archiveStatus === 'archived') {
      query = query.eq('is_archived', true);
    }

    // Warning filter: status in progress and updated more than 90 days ago
    if (onlyWarnings) {
      const ninetyDaysAgo = new Date();
      ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
      const dateStr = ninetyDaysAgo.toISOString().split('T')[0];
      query = query
        .in('status', ['Создан', 'На проверке'])
        .lte('request_date', dateStr);
    }

    // Pending filter: status in progress ('Создан', 'На проверке')
    if (onlyPending) {
      query = query.in('status', ['Создан', 'На проверке']);
    }

    query = applyFilters(query, req);

    // Dynamic sorting
    const allowedSortFields = [
      'ticket_number',
      'system_type',
      'bsp_request_number',
      'tch_request_number',
      'request_date',
      'amount',
      'agent_refund_equivalent',
      'agent_name',
      'requested_by',
      'status',
      'updated_at'
    ];
    const sortBy = allowedSortFields.includes(req.query.sort_by) ? req.query.sort_by : 'updated_at';
    const sortDir = req.query.sort_dir === 'asc' ? 'asc' : 'desc';
    const ascending = sortDir === 'asc';

    // Order and paginate
    query = query
      .order(sortBy, { ascending })
      .range(offset, offset + limit - 1);

    const { data, error, count } = await query;
    if (error) throw error;

    res.json({
      data: data || [],
      pagination: {
        page,
        limit,
        totalRecords: count || 0,
        totalPages: Math.ceil((count || 0) / limit)
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. GET /api/refunds/stats - Dashboard metrics (grouped by currency for authorized sum)
app.get('/api/refunds/stats', authenticateToken, async (req, res) => {
  try {
    // Count total pending
    let queryPending = db
      .from('refund_applications')
      .select('*', { count: 'exact', head: true })
      .in('status', ['Создан', 'На проверке'])
      .eq('is_archived', false);
    queryPending = applyFilters(queryPending, req);
    const { count: totalPending, error: pendingErr } = await queryPending;
    if (pendingErr) throw pendingErr;

    // Count 90+ days warning items (in progress)
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    const dateStr = ninetyDaysAgo.toISOString().split('T')[0];
    let queryWarn = db
      .from('refund_applications')
      .select('*', { count: 'exact', head: true })
      .in('status', ['Создан', 'На проверке'])
      .lte('request_date', dateStr)
      .eq('is_archived', false);
    queryWarn = applyFilters(queryWarn, req);
    const { count: activeWarningsCount, error: warnErr } = await queryWarn;
    if (warnErr) throw warnErr;

    // Total tickets in system matching filters
    let queryTotal = db
      .from('refund_applications')
      .select('*', { count: 'exact', head: true })
      .eq('is_archived', false);
    queryTotal = applyFilters(queryTotal, req);
    const { count: totalCreated, error: totalErr } = await queryTotal;
    if (totalErr) throw totalErr;

    // Sum of authorized refund amounts grouped by currency
    // For 'авторизовано с расхождением' we use the authorized_amount, otherwise the main amount
    // Fetch in pages of 1000 to circumvent PostgREST max_rows limit
    let authData = [];
    let from = 0;
    let to = 999;
    let hasMore = true;
    while (hasMore) {
      let queryAuth = db
        .from('refund_applications')
        .select('currency, status, amount, authorized_amount')
        .in('status', ['Авторизовано', 'авторизовано с расхождением'])
        .range(from, to);
      queryAuth = applyFilters(queryAuth, req);
      
      const { data: batchData, error: authErr } = await queryAuth;

      if (authErr) throw authErr;
      if (!batchData || batchData.length === 0) {
        hasMore = false;
      } else {
        authData = authData.concat(batchData);
        if (batchData.length < 1000) {
          hasMore = false;
        } else {
          from += 1000;
          to += 1000;
        }
      }
    }

    const sumsByCurrency = {};
    if (authData) {
      for (const row of authData) {
        const val = row.status === 'авторизовано с расхождением' ? (row.authorized_amount || 0) : (row.amount || 0);
        sumsByCurrency[row.currency] = (sumsByCurrency[row.currency] || 0) + parseFloat(val);
      }
    }

    const authorizedSums = Object.keys(sumsByCurrency).map(curr => ({
      currency: curr,
      sum: Math.round(sumsByCurrency[curr] * 100) / 100
    }));

    res.json({
      totalPending: totalPending || 0,
      authorizedSums,
      activeWarningsCount: activeWarningsCount || 0,
      totalCreated: totalCreated || 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. POST /api/refunds - Create new application
app.post('/api/refunds', authenticateToken, async (req, res) => {
  const {
    ticket_number,
    bsp_request_number,
    tch_request_number,
    system_type,
    validator,
    request_date,
    amount_eur, // This maps to the amount value (numeric)
    currency,   // Selected currency from form (RUB, TRY, EUR, etc.)
    agent_refund_equivalent,
    agent_name,
    requested_by,
    operator_email,
    operator_rocketchat,
    comment,
    refund_type,
    support_ticket
  } = req.body;

  let final_requested_by = requested_by;
  let final_operator_email = operator_email;
  let final_operator_rocketchat = operator_rocketchat;

  if (req.user.role === 'employee') {
    final_requested_by = req.user.full_name;
    final_operator_email = req.user.email;
    final_operator_rocketchat = req.user.rocketchat_username;
  }

  // Basic Validation
  if (!ticket_number || ticket_number.length !== 13 || isNaN(ticket_number)) {
    return res.status(400).json({ error: "Номер билета должен состоять ровно из 13 цифр." });
  }
  if (!system_type || !validator || !request_date || !amount_eur || !agent_name || !final_requested_by || !final_operator_rocketchat || !support_ticket) {
    return res.status(400).json({ error: "Пожалуйста, заполните все обязательные поля." });
  }

  const status = 'Создан';

  try {
    const { data: newTicket, error } = await db
      .from('refund_applications')
      .insert([
        {
          ticket_number,
          bsp_request_number: bsp_request_number || null,
          tch_request_number: tch_request_number || null,
          system_type,
          validator,
          request_date,
          amount: parseFloat(amount_eur),
          currency: currency || 'EUR',
          agent_refund_equivalent: agent_refund_equivalent ? parseFloat(agent_refund_equivalent) : null,
          agent_name,
          requested_by: final_requested_by,
          operator_email: final_operator_email || null,
          operator_rocketchat: final_operator_rocketchat || null,
          status,
          status_updated_at: request_date,
          refund_type,
          support_ticket
        }
      ])
      .select('*')
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(400).json({ error: "Заявка с таким номером билета и номером RA уже существует." });
      }
      throw error;
    }

    const newId = newTicket.id;
    const historyComment = comment ? `Создание: ${comment}` : 'Создание новой заявки';

    // Log in status history
    const { error: histErr } = await db
      .from('status_history')
      .insert([
        {
          application_id: newId,
          old_status: null,
          new_status: status,
          changed_by: final_requested_by,
          comment: historyComment
        }
      ]);

    if (histErr) console.error("History logging error:", histErr.message);

    // Sync newly created ticket to Google Sheets (with action metadata)
    syncToGoogleSheets({
      action: 'create',
      changed_by: final_requested_by,
      comment: comment || 'Создание новой заявки',
      old_status: null,
      ticket: newTicket
    }).catch(e => console.error("Google Sheets sync failed:", e));

    res.status(201).json({ id: newId, ticket_number, status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. PUT /api/refunds/:id/status - Update refund status with optional comment & authorized_amount
app.put('/api/refunds/:id/status', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { new_status, comment, authorized_amount } = req.body;
  const operatorName = req.user.full_name || 'СОФИ';

  if (!new_status) {
    return res.status(400).json({ error: "Укажите новый статус." });
  }

  try {
    // Fetch current ticket details
    const { data: ticket, error: findErr } = await db
      .from('refund_applications')
      .select('*')
      .eq('id', id)
      .single();

    if (findErr) throw findErr;
    if (!ticket) return res.status(404).json({ error: "Заявка не найдена." });

    const oldStatus = ticket.status;
    const ticketNumber = ticket.ticket_number;
    const operatorCreator = ticket.requested_by;
    const operatorEmail = ticket.operator_email;
    const operatorRocketChat = ticket.operator_rocketchat;
    const today = new Date().toISOString().split('T')[0];
    const amount = ticket.amount;
    const currency = ticket.currency;

    const updateData = {
      status: new_status,
      status_updated_at: today,
      updated_at: new Date().toISOString()
    };

    if (new_status === 'авторизовано с расхождением') {
      updateData.authorized_amount = parseFloat(authorized_amount || '0');
    } else {
      updateData.authorized_amount = null;
    }

    const { error: updateErr } = await db
      .from('refund_applications')
      .update(updateData)
      .eq('id', id);

    if (updateErr) throw updateErr;

    // Save status history audit log
    const { error: histErr } = await db
      .from('status_history')
      .insert([
        {
          application_id: id,
          old_status: oldStatus,
          new_status: new_status,
          changed_by: operatorName,
          comment: comment || null
        }
      ]);

    if (histErr) console.error("Audit log insert failed:", histErr.message);

    // Fetch updated ticket to get final values for Sheets
    const { data: updatedTicket, error: getErr } = await db
      .from('refund_applications')
      .select('*')
      .eq('id', id)
      .single();

    if (!getErr && updatedTicket) {
      // Trigger notifications async
      notifyStatusChange({
        ticketNumber,
        oldStatus,
        newStatus: new_status,
        changedBy: operatorName,
        comment,
        operatorEmail,
        operatorRocketChat,
        operatorName: operatorCreator,
        amount,
        currency,
        authorizedAmount: parseFloat(authorized_amount || '0'),
        systemType: ticket.system_type,
        bspRequestNumber: ticket.bsp_request_number,
        tchRequestNumber: ticket.tch_request_number,
        refundType: ticket.refund_type,
        supportTicket: ticket.support_ticket
      }).catch(e => console.error("Notifications triggering error:", e.message));

      // Sync updated ticket to Google Sheets
      syncToGoogleSheets({
        action: 'status_change',
        changed_by: operatorName,
        comment: comment || null,
        old_status: oldStatus,
        ticket: updatedTicket
      }).catch(e => console.error("Google Sheets sync failed:", e));
    }

    res.json({ id, old_status: oldStatus, new_status, message: "Статус успешно обновлен." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4b. PUT /api/refunds/:id - Update refund details (Edit)
app.put('/api/refunds/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const {
    ticket_number,
    bsp_request_number,
    tch_request_number,
    system_type,
    validator,
    request_date,
    amount_eur,
    currency,
    agent_refund_equivalent,
    agent_name,
    requested_by,
    operator_email,
    operator_rocketchat,
    comment,
    refund_type,
    support_ticket
  } = req.body;

  try {
    // Fetch old ticket details
    const { data: oldTicket, error: getOldErr } = await db
      .from('refund_applications')
      .select('*')
      .eq('id', id)
      .single();
    
    if (getOldErr || !oldTicket) {
      return res.status(404).json({ error: "Заявка не найдена." });
    }

    const oldStatus = oldTicket.status;

    let final_requested_by = requested_by;
    let final_operator_email = operator_email;
    let final_operator_rocketchat = operator_rocketchat;

    if (req.user.role === 'employee') {
      // Prevent modification of operator contact fields
      final_requested_by = oldTicket.requested_by;
      final_operator_email = oldTicket.operator_email;
      final_operator_rocketchat = oldTicket.operator_rocketchat;
    }

    // Basic Validation
    if (!ticket_number || ticket_number.length !== 13 || isNaN(ticket_number)) {
      return res.status(400).json({ error: "Номер билета должен состоять ровно из 13 цифр." });
    }
    if (!system_type || !validator || !request_date || !amount_eur || !agent_name || !final_requested_by || !final_operator_rocketchat || !support_ticket) {
      return res.status(400).json({ error: "Пожалуйста, заполните все обязательные поля." });
    }

    // Update DB
    const { error: updateErr } = await db
      .from('refund_applications')
      .update({
        ticket_number,
        bsp_request_number: bsp_request_number || null,
        tch_request_number: tch_request_number || null,
        system_type,
        validator,
        request_date,
        amount: parseFloat(amount_eur),
        currency,
        agent_refund_equivalent: agent_refund_equivalent ? parseFloat(agent_refund_equivalent) : null,
        agent_name,
        requested_by: final_requested_by,
        operator_email: final_operator_email || null,
        operator_rocketchat: final_operator_rocketchat || null,
        refund_type,
        support_ticket,
        updated_at: new Date().toISOString()
      })
      .eq('id', id);

    if (updateErr) {
      if (updateErr.code === '23505') {
        return res.status(400).json({ error: "Заявка с таким номером билета и номером RA уже существует." });
      }
      throw updateErr;
    }

    const commentText = comment ? `Редактирование: ${comment}` : 'Редактирование параметров заявки';
    
    // Log to audit history
    const { error: histErr } = await db
      .from('status_history')
      .insert([
        {
          application_id: id,
          old_status: 'Изменен',
          new_status: 'Изменен',
          changed_by: req.user.full_name || final_requested_by,
          comment: commentText
        }
      ]);

    if (histErr) console.error("Edit audit log failed:", histErr.message);

    // Fetch updated ticket and sync it to Google Sheets
    const { data: updatedTicket, error: getErr } = await db
      .from('refund_applications')
      .select('*')
      .eq('id', id)
      .single();

    if (!getErr && updatedTicket) {
      syncToGoogleSheets({
        action: 'edit',
        changed_by: req.user.full_name || final_requested_by,
        comment: comment || 'Редактирование параметров заявки',
        old_status: oldStatus,
        ticket: updatedTicket
      }).catch(e => console.error("Google Sheets sync failed:", e));
    }

    res.json({ success: true, message: "Заявка успешно отредактирована." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4c. DELETE /api/refunds/:id - Delete refund application
app.delete('/api/refunds/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const { error } = await db
      .from('refund_applications')
      .delete()
      .eq('id', id);
      
    if (error) throw error;
    res.json({ success: true, message: "Заявка успешно удалена." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. GET /api/refunds/:id/history - Get status audit trail
app.get('/api/refunds/:id/history', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const { data, error } = await db
      .from('status_history')
      .select('*')
      .eq('application_id', id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. GET /api/notifications - Get in-app notifications
app.get('/api/notifications', authenticateToken, async (req, res) => {
  const recipient = req.query.recipient || ''; 
  
  try {
    let query = db.from('inapp_notifications').select('*');
    if (recipient) {
      query = query.eq('recipient', recipient);
    }
    
    const { data, error } = await query
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. PUT /api/notifications/read - Mark notifications as read
app.put('/api/notifications/read', authenticateToken, async (req, res) => {
  const { ids, recipient } = req.body;

  try {
    let query = db.from('inapp_notifications').update({ is_read: 1 });

    if (ids && Array.isArray(ids)) {
      query = query.in('id', ids);
    } else if (recipient) {
      query = query.eq('recipient', recipient);
    } else {
      return res.status(400).json({ error: "Укажите ids или recipient для пометки прочитанным." });
    }

    const { error } = await query;
    if (error) throw error;
    res.json({ success: true, message: "Уведомления помечены как прочитанные." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 8. GET /api/settings - Get settings (with masked passwords)
app.get('/api/settings', authenticateToken, requireAdmin, async (req, res) => {
  const settings = await getSettings();
  const masked = { ...settings };
  if (masked.smtp_pass) masked.smtp_pass = '••••••••';
  if (masked.rocketchat_token) masked.rocketchat_token = '••••••••';
  res.json(masked);
});

// GET /api/notification-logs - Retrieve system notification logs (Admin only)
app.get('/api/notification-logs', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '50');
    const offset = parseInt(req.query.offset || '0');
    const fetchAll = req.query.all === 'true';

    let query = db
      .from('notification_logs')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false });

    if (!fetchAll) {
      query = query.range(offset, offset + limit - 1);
    }

    const { data, count, error } = await query;

    if (error) {
      if (error.code === 'PGRST116' || error.message.includes('relation') || error.message.includes('does not exist')) {
        return res.json({ logs: [], total: 0 });
      }
      throw error;
    }

    res.json({ logs: data || [], total: count || 0 });
  } catch (err) {
    console.error("Error fetching notification logs:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// 9. PUT /api/settings - Update settings
app.put('/api/settings', authenticateToken, requireAdmin, async (req, res) => {
  const success = await saveSettings(req.body);
  if (success) {
    res.json({ success: true, message: "Настройки успешно сохранены." });
  } else {
    res.status(500).json({ error: "Не удалось сохранить настройки в базу данных." });
  }
});

// 10. POST /api/settings/test - Test connection using current form configuration
app.post('/api/settings/test', authenticateToken, requireAdmin, async (req, res) => {
  const currentSettings = await getSettings();
  const testSettings = { ...req.body };
  
  // Resolve masked values
  if (testSettings.smtp_pass === '••••••••') {
    testSettings.smtp_pass = currentSettings.smtp_pass;
  }
  if (testSettings.rocketchat_token === '••••••••') {
    testSettings.rocketchat_token = currentSettings.rocketchat_token;
  }

  const logs = [];
  let emailSuccess = true;
  let rcSuccess = true;
  let errorMsg = "";

  // 1. Test Email if SMTP is configured
  if (testSettings.smtp_host && testSettings.smtp_user) {
    try {
      logs.push("⏳ Тестирование Email...");
      const emailHtml = `
        <h2>Тестовое оповещение Refund Manager</h2>
        <p>Настройки SMTP введены корректно! Соединение установлено.</p>
        <p>Дата теста: ${new Date().toLocaleString('ru-RU')}</p>
      `;
      await sendEmailNotification(testSettings.smtp_user, "Тестовое оповещение", emailHtml, testSettings);
      logs.push("✅ Email отправлен успешно на " + testSettings.smtp_user);
    } catch (e) {
      emailSuccess = false;
      errorMsg += `Ошибка SMTP: ${e.message}. `;
      logs.push("❌ Ошибка Email: " + e.message);
    }
  } else {
    logs.push("ℹ️ SMTP не настроен, пропуск теста Email.");
  }

  // 2. Test Rocket Chat if configured
  if (testSettings.rocketchat_url) {
    try {
      logs.push("⏳ Тестирование Rocket Chat...");
      const msg = `🧪 *Тестовый алерт Refund Manager!*\nНастройки Rocket Chat введены верно. Тест пройден успешно!`;
      
      await sendRocketChatNotification(msg, null, testSettings);
      logs.push("✅ Сообщение в Rocket Chat отправлено успешно.");
    } catch (e) {
      rcSuccess = false;
      errorMsg += `Ошибка Rocket Chat: ${e.message}. `;
      logs.push("❌ Ошибка Rocket Chat: " + e.message);
    }
  } else {
    logs.push("ℹ️ Rocket Chat не настроен, пропуск теста чата.");
  }

  const overallSuccess = emailSuccess && rcSuccess;
  res.json({
    success: overallSuccess,
    logs,
    error: overallSuccess ? null : errorMsg.trim()
  });
});

// Dynamic Validators API endpoints
app.get('/api/validators', authenticateToken, async (req, res) => {
  try {
    const list = await getValidatorsFromDb();
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/validators', authenticateToken, requireAdmin, async (req, res) => {
  const { code, system_type } = req.body;
  if (!code || !code.trim()) {
    return res.status(400).json({ error: "Код валидатора пуст." });
  }
  const cleanCode = code.trim().toUpperCase();
  const systemType = system_type || 'BSP Link';

  try {
    const { error } = await db
      .from('validators')
      .insert([{ code: cleanCode, system_type: systemType }]);

    if (error) {
      if (error.code === '23505') {
        return res.status(400).json({ error: `Валидатор ${cleanCode} уже существует.` });
      }
      throw error;
    }
    res.status(201).json({ success: true, code: cleanCode });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/validators/:code', authenticateToken, requireAdmin, async (req, res) => {
  const { code } = req.params;
  const cleanCode = code.trim().toUpperCase();

  try {
    const { error } = await db
      .from('validators')
      .delete()
      .eq('code', cleanCode);
      
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Unprotected health-check route for cron and uptime monitors
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// POST /api/sync - Trigger manual synchronization from Google Sheets
app.post('/api/sync', authenticateToken, async (req, res) => {
  try {
    console.log(`🔄 Manual sync triggered by user: ${req.user.full_name || req.user.username}`);
    const stats = await runImport();
    res.json({
      success: true,
      message: "Синхронизация успешно завершена.",
      stats
    });
  } catch (err) {
    console.error("❌ Manual sync failed:", err.message);
    res.status(500).json({ error: "Ошибка при синхронизации: " + err.message });
  }
});

// Auto-sync schedule: every 30 minutes in the background
const AUTO_SYNC_INTERVAL = 30 * 60 * 1000;
setInterval(async () => {
  try {
    console.log("⏰ Running background auto-sync with Google Sheets...");
    const stats = await runImport();
    console.log(`✅ Background sync completed: processed ${stats.processed}, imported ${stats.inserted}, updated ${stats.updated}, skipped ${stats.skipped}.`);
  } catch (err) {
    console.error("❌ Background auto-sync failed:", err.message);
  }
}, AUTO_SYNC_INTERVAL);

// Catch-all route to serve the React frontend for client-side routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server after initializing database connection
initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 Refund Applications API Server listening on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error("❌ Database initialization failed:", err);
    process.exit(1);
  });
