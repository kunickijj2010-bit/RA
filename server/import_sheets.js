const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { db } = require('./database');

const HTML_FILE_PATH = path.join(__dirname, '..', '..', 'sheet_page.html');

// Helper to transliterate Russian characters to Latin
function transliterate(str) {
  const ru = {
    'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'e', 'ж': 'zh',
    'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o',
    'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u', 'ф': 'f', 'х': 'kh', 'ц': 'ts',
    'ч': 'ch', 'ш': 'sh', 'щ': 'shch', 'ы': 'y', 'э': 'e', 'ю': 'yu', 'я': 'ya',
    'ь': '', 'ъ': ''
  };
  return str.toLowerCase().split('').map(char => ru[char] !== undefined ? ru[char] : char).join('');
}

// Generate login matching pattern initial.lastname
function generateUsername(fullName) {
  const cleanName = fullName.replace(/[^а-яА-Яa-zA-Z\s.]/g, '').trim();
  const parts = cleanName.split(/\s+/);
  
  if (parts.length >= 2) {
    // Determine last name and first name/initials
    let lastName = '';
    let initial = '';
    
    // Check if the first word has dots (Initials) or if it's the last name
    // Russian sheet standard is usually Lastname Initials (e.g. Анисимова О.А.)
    if (parts[1].includes('.') || parts[1].length <= 2) {
      lastName = transliterate(parts[0]).replace(/[^a-z]/g, '');
      initial = transliterate(parts[1][0]).replace(/[^a-z]/g, '');
    } else {
      // Lastname Firstname (e.g. Иванова Илона)
      lastName = transliterate(parts[0]).replace(/[^a-z]/g, '');
      initial = transliterate(parts[1][0]).replace(/[^a-z]/g, '');
    }
    
    if (!initial || !lastName) {
      return transliterate(cleanName).replace(/[^a-z.]/g, '');
    }
    return `${initial}.${lastName}`;
  } else {
    // Only one word (e.g. Шляхтун)
    return transliterate(parts[0]).replace(/[^a-z.]/g, '');
  }
}

// Map various sheet statuses to system statuses
function mapStatus(statusStr) {
  if (!statusStr || !statusStr.trim()) return 'Создан';
  const s = statusStr.trim().toLowerCase();
  if (s.includes('расхожд') || s.includes('расхождение')) {
    return 'авторизовано с расхождением';
  } else if (s.includes('авториз') || s === 'ок' || s === 'ok' || s.includes('проведен')) {
    return 'Авторизовано';
  } else if (s.includes('отклон') || s.includes('отказ')) {
    return 'Отклонено';
  } else if (s.includes('выполнен в гдс') || s.includes('выполнен в gds')) {
    return 'Выполнен в ГДС';
  } else if (s.includes('отозван')) {
    return 'Отозвано';
  } else if (s.includes('провер') || s.includes('на проверке')) {
    return 'На проверке';
  } else if (s.includes('создан')) {
    return 'Создан';
  }
  return 'Создан';
}

// Helper to parse dates in format dd.mm.yy or dd/mm/yyyy or dd,mm,yy
function parseDate(dateStr) {
  if (!dateStr || !dateStr.trim()) return new Date().toISOString().split('T')[0];
  const cleaned = dateStr.trim();
  
  // Strip spaces and match
  const m = cleaned.replace(/\s/g, '').match(/^(\d{1,2})[.,/](\d{1,2})[.,/](\d{2,4})$/);
  if (m) {
    let day = parseInt(m[1]);
    let month = parseInt(m[2]);
    let year = parseInt(m[3]);
    if (year < 100) {
      year = year <= 40 ? 2000 + year : 1900 + year;
    }
    
    // Swap month/day if MM.DD.YYYY format
    if (month > 12 && day <= 12) {
      const temp = day;
      day = month;
      month = temp;
    }
    
    // Clamp day to max days of the month to prevent database insert errors (e.g. September 31 -> September 30)
    if (month >= 1 && month <= 12 && year >= 1900 && year <= 2100) {
      const maxDays = new Date(year, month, 0).getDate();
      if (day > maxDays) {
        day = maxDays;
      }
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }
  
  // Try matching yyyy-mm-dd
  if (cleaned.match(/^\d{4}-\d{2}-\d{2}$/)) {
    const parts = cleaned.split('-');
    const y = parseInt(parts[0]);
    const m = parseInt(parts[1]);
    let d = parseInt(parts[2]);
    
    if (m >= 1 && m <= 12 && y >= 1900 && y <= 2100) {
      const maxDays = new Date(y, m, 0).getDate();
      if (d > maxDays) {
        d = maxDays;
      }
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }
  
  return new Date().toISOString().split('T')[0];
}

// Helper to parse amount and extract currency
function parseAmountCurrency(amountStr, defaultCurrency = 'EUR') {
  if (!amountStr || !amountStr.trim()) return { amount: 0, currency: defaultCurrency };
  const cleaned = amountStr.trim().replace(/\s/g, '').replace(/,/g, '.');
  
  const currencyMatch = cleaned.match(/(KZT|TRY|AED|RUB|EUR|USD|руб|TL|AED)/i);
  let currency = defaultCurrency;
  if (currencyMatch) {
    const cur = currencyMatch[1].toUpperCase();
    if (cur === 'РУБ') currency = 'RUB';
    else if (cur === 'TL') currency = 'TRY';
    else currency = cur;
  }
  
  const numMatch = cleaned.match(/[\d.]+/);
  let amount = numMatch ? parseFloat(numMatch[0]) : 0;
  if (isNaN(amount)) amount = 0;
  return { amount, currency };
}

// Parse equivalent
function parseEquivalent(equivStr) {
  if (!equivStr || !equivStr.trim()) return null;
  const cleaned = equivStr.trim().replace(/\s/g, '').replace(/,/g, '.');
  const numMatch = cleaned.match(/[\d.]+/);
  if (!numMatch) return null;
  const val = parseFloat(numMatch[0]);
  return isNaN(val) ? null : val;
}

// Built-in basic CSV Parser
function parseCSV(text) {
  const lines = [];
  let row = [];
  let inQuotes = false;
  let cell = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i+1];
    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        cell += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      row.push(cell.trim());
      cell = '';
    } else if ((char === '\r' || char === '\n') && !inQuotes) {
      if (char === '\r' && nextChar === '\n') i++;
      row.push(cell.trim());
      lines.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (cell || row.length > 0) {
    row.push(cell.trim());
    lines.push(row);
  }
  return lines;
}

// Main logic
async function run() {
  const dryRun = process.argv.includes('--dry-run');
  console.log(`🚀 Starting Google Sheets Migration (${dryRun ? 'DRY RUN - SIMULATION' : 'REAL RUN'})`);

  if (!fs.existsSync(HTML_FILE_PATH)) {
    throw new Error(`❌ HTML File not found at: ${HTML_FILE_PATH}`);
  }

  // 1. Fetch active validators from database
  console.log("Fetching validators from database...");
  const { data: dbValidators, error: valErr } = await db.from('validators').select('*');
  if (valErr) {
    throw new Error("❌ Failed to fetch validators: " + valErr.message);
  }
  console.log(`Found ${dbValidators.length} validators in database.`);

  // 2. Parse sheet titles and GIDs from HTML
  const html = fs.readFileSync(HTML_FILE_PATH, 'utf8');
  const pattern = /\\?"(\d{8,11})\\?",\s*\[\s*\{\s*\\?"1\\?"\s*:\s*\[\s*\[\s*0\s*,\s*0\s*,\s*\\?"([^"\\]+)\\?"/g;
  const mappings = [];
  let match;
  while ((match = pattern.exec(html)) !== null) {
    mappings.push({ gid: match[1], name: match[2].trim() });
  }

  console.log(`Discovered ${mappings.length} tabs in HTML metadata.`);

  // 3. For each sheet tab, find if it matches an active validator
  const activeTabs = [];
  for (const m of mappings) {
    const cleanTab = m.name.toLowerCase().replace(/[^a-zа-я0-9]/g, '').trim();
    let matchedValidator = null;

    matchedValidator = dbValidators.find(v => {
      const cleanCode = v.code.toLowerCase().replace(/[^a-zа-я0-9]/g, '').trim();
      return cleanCode === cleanTab;
    });

    if (!matchedValidator) {
      const cyrToLat = {
        'м': 'm', 'в': 'b', 'а': 'a', 'о': 'o', 'к': 'k', 'с': 'c', 'х': 'kh', 'е': 'e', 'т': 't'
      };
      const normalize = (s) => s.split('').map(c => cyrToLat[c] || c).join('');
      const normTab = normalize(cleanTab);
      
      matchedValidator = dbValidators.find(v => {
        const cleanCode = v.code.toLowerCase().replace(/[^a-zа-я0-9]/g, '').trim();
        return normalize(cleanCode) === normTab;
      });
    }

    const digitsMatch = m.name.match(/\d+/);
    if (!matchedValidator && digitsMatch) {
      const codeNum = digitsMatch[0];
      matchedValidator = dbValidators.find(v => {
        const cleanCode = v.code.toLowerCase().replace(/[^a-zа-я0-9]/g, '').trim();
        return cleanCode === codeNum || cleanCode.replace(/\D/g, '') === codeNum;
      });
    }

    if (!matchedValidator) {
      matchedValidator = dbValidators.find(v => {
        const cleanCode = v.code.toLowerCase().replace(/[^a-zа-я0-9]/g, '').trim();
        return cleanCode.includes(cleanTab) || cleanTab.includes(cleanCode);
      });
    }

    if (matchedValidator) {
      activeTabs.push({
        gid: m.gid,
        tabName: m.name,
        validatorCode: matchedValidator.code,
        systemType: matchedValidator.system_type
      });
    } else {
      console.log(`⚠️ Tab '${m.name}' skipped (no matching active validator found).`);
    }
  }

  console.log(`\nMatched ${activeTabs.length} tabs to active validators.`);

  // Fetch existing users to avoid duplicates
  const { data: dbUsers, error: usersErr } = await db.from('users').select('*');
  if (usersErr) {
    throw new Error("❌ Failed to fetch users: " + usersErr.message);
  }
  const existingUsernames = new Set(dbUsers.map(u => u.username));
  const existingFullNames = new Set(dbUsers.map(u => u.full_name));

  const newOperators = new Set();
  const rawApplications = [];

  // 4. Download and parse CSV files
  for (const tab of activeTabs) {
    console.log(`\nDownloading Tab '${tab.tabName}' (GID: ${tab.gid})...`);
    try {
      const csvUrl = `https://docs.google.com/spreadsheets/d/1vuozEZO8tqXysSmY9dyRk-kPVrEcND-3YiT2g66SGzY/export?format=csv&gid=${tab.gid}`;
      const res = await fetch(csvUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      
      const rows = parseCSV(text);
      if (rows.length < 2) {
        console.log(`  (Empty sheet, skipping)`);
        continue;
      }

      // Fetch HTML view to detect hidden rows
      console.log(`  Fetching HTML view to detect hidden rows...`);
      let visibleRows = null;
      try {
        const htmlUrl = `https://docs.google.com/spreadsheets/d/1vuozEZO8tqXysSmY9dyRk-kPVrEcND-3YiT2g66SGzY/htmlview/sheet?headers=true&gid=${tab.gid}`;
        const htmlRes = await fetch(htmlUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          }
        });
        if (htmlRes.ok) {
          const htmlText = await htmlRes.text();
          visibleRows = new Set();
          const regex = new RegExp(`id="${tab.gid}R(\\d+)"`, 'g');
          let m;
          while ((m = regex.exec(htmlText)) !== null) {
            visibleRows.add(parseInt(m[1]));
          }
          console.log(`  Detected ${visibleRows.size} visible rows in HTML view.`);
        } else {
          console.log(`  ⚠️ Failed to fetch HTML view (HTTP ${htmlRes.status}). Defaulting to all rows visible.`);
        }
      } catch (htmlErr) {
        console.log(`  ⚠️ Error fetching HTML view: ${htmlErr.message}. Defaulting to all rows visible.`);
      }

      // Dynamic column mapping based on headers
      const header = rows[0];
      let colTicket = -1;
      let colOtrs = -1;
      let colRa = -1;
      let colDate = -1;
      let colAmount = -1;
      let colAgent = -1;
      let colOperator = -1;
      let colStatus = -1;
      let colStatusDate = -1;
      let colEquivalent = -1;
      let colModifier = -1;
      let colComment = -1;

      for (let idx = 0; idx < header.length; idx++) {
        const h = header[idx].toLowerCase().trim();
        if (!h) {
          if (idx === 0 && colTicket === -1) colTicket = 0;
          else if (idx === 2 && colRa === -1) colRa = 2;
          continue;
        }
        
        // Ticket number check
        if ((h.includes('билет') || h === 'ticket_number' || h === 'tkt') && colTicket === -1) {
          colTicket = idx;
        }
        // OTRS ticket check
        else if ((h.includes('тикет') || h.includes('ticket') || h.includes('otrs') || h.includes('номер заявки')) && colOtrs === -1) {
          colOtrs = idx;
        }
        // RA check
        const cleanH = h.replace(/[^a-zа-я0-9\s#]/g, '').trim();
        const isRaHeader = 
          cleanH === 'номер ра' ||
          cleanH === 'номер ra' ||
          cleanH === 'номер запроса' ||
          cleanH === 'refund number' ||
          cleanH === 'номер refund application' ||
          cleanH === 'ra' ||
          cleanH === 'ра' ||
          cleanH === 'запрос' ||
          cleanH === 'запроса' ||
          cleanH === 'refund application' ||
          cleanH === 'refund #' ||
          cleanH === 'номер запроса ра' ||
          cleanH === 'номер запроса ra' ||
          cleanH === '400504984' ||
          cleanH === '0400504984';

        if (isRaHeader && colRa === -1) {
          colRa = idx;
        }
        
        // Date check (matches header word 'дата'/'date' or matches format dd.mm.yy etc)
        const isDateHeader = h.includes('дата') || h.includes('date') || h.replace(/\s/g, '').match(/^\d{1,2}[.,/]\d{1,2}[.,/]\d{2,4}$/);
        if (isDateHeader) {
          if (colDate === -1) colDate = idx;
          else colStatusDate = idx;
        }
        // Amount check
        else if ((h.includes('сумма') || h.includes('amount') || h.includes('price')) && !h.includes('эквивалент') && !h.includes('equivalent') && colAmount === -1) {
          colAmount = idx;
        }
        // Agent check
        else if ((h.includes('агент') || h.includes('agent')) && !h.includes('эквивалент') && !h.includes('equivalent') && colAgent === -1) {
          colAgent = idx;
        }
        // Operator and Modifier check
        else if ((h.includes('запросил') || h.includes('оператор') || h.includes('сотрудник') || h.includes('кем') || h.includes('кто') || h === 'user') && !h.includes('внес') && !h.includes('внесла') && colOperator === -1) {
          colOperator = idx;
        }
        else if ((h.includes('внес') || h.includes('внесла') || h.includes('изменил')) && colModifier === -1) {
          colModifier = idx;
        }
        // Status check
        else if ((h.includes('авторизац') || h.includes('статус') || h.includes('status') || h.includes('решение')) && colStatus === -1) {
          colStatus = idx;
        }
        // Equivalent check
        else if ((h.includes('эквивалент') || h.includes('equivalent')) && colEquivalent === -1) {
          colEquivalent = idx;
        }
        // Comment check
        else if ((h.includes('коммент') || h.includes('примечан') || h.includes('comment') || h.includes('note')) && colComment === -1) {
          colComment = idx;
        }
      }

      // Fallbacks
      if (colTicket === -1) colTicket = 0;
      if (colRa === -1 && header.length > 2) colRa = 2;

      console.log(`  Mapping: ticket=${colTicket}, otrs=${colOtrs}, ra=${colRa}, date=${colDate}, amount=${colAmount}, agent=${colAgent}, operator=${colOperator}, status=${colStatus}, equiv=${colEquivalent}, comment=${colComment}`);

      let defaultCurrency = 'RUB';
      if (tab.tabName.toLowerCase().includes('turkish') || tab.tabName.toLowerCase().includes('tl')) defaultCurrency = 'TRY';
      else if (tab.tabName.toLowerCase().includes('казахстан') || tab.tabName.toLowerCase().includes('kzt')) defaultCurrency = 'KZT';
      else if (tab.tabName.toLowerCase().includes('дубай') || tab.tabName.toLowerCase().includes('aed')) defaultCurrency = 'AED';
      else if (tab.tabName.toLowerCase().includes('екб')) defaultCurrency = 'RUB';

      if (colAmount !== -1 && header[colAmount]) {
        const amountHeader = header[colAmount].toLowerCase();
        if (amountHeader.includes('руб') || amountHeader.includes('rub')) {
          defaultCurrency = 'RUB';
        } else if (amountHeader.includes('eur') || amountHeader.includes('евро')) {
          defaultCurrency = 'EUR';
        } else if (amountHeader.includes('usd') || amountHeader.includes('долл')) {
          defaultCurrency = 'USD';
        } else if (amountHeader.includes('kzt') || amountHeader.includes('тнг') || amountHeader.includes('тенге')) {
          defaultCurrency = 'KZT';
        } else if (amountHeader.includes('try') || amountHeader.includes('tl') || amountHeader.includes('лир')) {
          defaultCurrency = 'TRY';
        } else if (amountHeader.includes('aed') || amountHeader.includes('дирх')) {
          defaultCurrency = 'AED';
        }
      }

      let parsedCount = 0;
      for (let rIdx = 1; rIdx < rows.length; rIdx++) {
        const row = rows[rIdx];
        if (row.length === 0 || row.join('').trim() === '') {
          continue;
        }
        if (!row[0]) continue;

        const ticketRaw = colTicket !== -1 ? row[colTicket] : '';
        let ticketNum = ticketRaw.replace(/\D/g, '');
        if (!ticketNum || ticketNum.length < 10) continue;
        if (ticketNum.length > 13) ticketNum = ticketNum.substring(0, 13);

        const requestedBy = colOperator !== -1 && row[colOperator] ? row[colOperator].trim() : 'Система';
        const changedBy = colModifier !== -1 && row[colModifier] ? row[colModifier].trim() : '';

        if (requestedBy && requestedBy !== 'Система' && requestedBy !== 'СОФИ') newOperators.add(requestedBy);
        if (changedBy && changedBy !== 'Система' && changedBy !== 'СОФИ') newOperators.add(changedBy);

        const rawAmountStr = colAmount !== -1 ? row[colAmount] : '';
        const { amount, currency } = parseAmountCurrency(rawAmountStr, defaultCurrency);

        const rawStatus = colStatus !== -1 ? row[colStatus] : '';
        const status = mapStatus(rawStatus);

        const rawDate = colDate !== -1 ? row[colDate] : '';
        const requestDate = parseDate(rawDate);

        const rawEquiv = colEquivalent !== -1 ? row[colEquivalent] : '';
        const agentRefundEquivalent = parseEquivalent(rawEquiv);

        // Check if row is hidden (archived) in Google Sheets
        const isArchived = visibleRows ? !visibleRows.has(rIdx) : false;

        const refundApplication = {
          ticket_number: ticketNum,
          system_type: tab.systemType,
          validator: tab.validatorCode,
          request_date: requestDate,
          amount,
          currency,
          agent_refund_equivalent: agentRefundEquivalent,
          agent_name: colAgent !== -1 && row[colAgent] ? row[colAgent].trim() : 'Неизвестный агент',
          requested_by: requestedBy,
          status,
          status_updated_at: colStatusDate !== -1 && row[colStatusDate] ? parseDate(row[colStatusDate]) : requestDate,
          support_ticket: colOtrs !== -1 && row[colOtrs] ? row[colOtrs].trim().replace(/\D/g, '') || '0' : '0',
          bsp_request_number: tab.systemType === 'BSP Link' && colRa !== -1 && row[colRa] ? row[colRa].trim().replace(/\D/g, '') : null,
          tch_request_number: tab.systemType === 'TCH Connect' && colRa !== -1 && row[colRa] ? row[colRa].trim().replace(/\D/g, '') : null,
          comment: colComment !== -1 && row[colComment] ? row[colComment].trim() : '',
          is_archived: isArchived
        };

        rawApplications.push(refundApplication);
        parsedCount++;
      }

      console.log(`  Parsed ${parsedCount} applications successfully.`);
    } catch (err) {
      console.error(`  ❌ Error processing tab '${tab.tabName}':`, err.message);
    }
  }

  // 5. Register new operators as employees
  console.log(`\nCollected ${newOperators.size} unique operators from Sheet.`);
  const operatorsToInsert = [];
  const generatedLogins = new Set(dbUsers.map(u => u.username));

  for (const opName of newOperators) {
    if (existingFullNames.has(opName)) continue;

    const baseUsername = generateUsername(opName);
    if (!baseUsername) continue;

    let finalUsername = baseUsername;
    let counter = 1;
    while (generatedLogins.has(finalUsername)) {
      finalUsername = `${baseUsername}${counter}`;
      counter++;
    }
    generatedLogins.add(finalUsername);

    const defaultPassword = `${finalUsername}123`;
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(defaultPassword, salt);

    operatorsToInsert.push({
      username: finalUsername,
      password_hash: passwordHash,
      full_name: opName,
      role: 'employee'
    });
  }

  console.log(`Operators ready to register: ${operatorsToInsert.length}`);

  // De-duplicate applications by composite key
  const uniqueAppsMap = new Map();
  for (const app of rawApplications) {
    const key = `${app.ticket_number}_${app.bsp_request_number || ''}_${app.tch_request_number || ''}`;
    const existing = uniqueAppsMap.get(key);
    if (!existing) {
      uniqueAppsMap.set(key, app);
    } else {
      const dateA = new Date(existing.request_date).getTime();
      const dateB = new Date(app.request_date).getTime();
      
      const statusPriority = {
        'Авторизовано': 5,
        'Выполнен в ГДС': 5,
        'Отозвано': 5,
        'Отклонено': 4,
        'авторизовано с расхождением': 3,
        'На проверке': 2,
        'Создан': 1
      };
      const pExisting = statusPriority[existing.status] || 0;
      const pNew = statusPriority[app.status] || 0;
      
      const preferNew = (!existing.is_archived && app.is_archived) ? false :
                        (existing.is_archived && !app.is_archived) ? true :
                        (dateB > dateA) ? true :
                        (dateB === dateA && pNew >= pExisting) ? true : false;
      if (preferNew) {
        uniqueAppsMap.set(key, app);
      }
    }
  }
  const deDuplicatedApplications = Array.from(uniqueAppsMap.values());
  console.log(`De-duplicated applications list: ${rawApplications.length} -> ${deDuplicatedApplications.length}`);

  // 6. DB Writing Phase
  if (dryRun) {
    console.log("\n================ DRY RUN SUMMARY ================");
    console.log(`Operators that would be added: ${operatorsToInsert.length}`);
    console.log(`Applications parsed and ready: ${deDuplicatedApplications.length}`);
    if (deDuplicatedApplications.length > 0) {
      console.log("Sample application item parsed:");
      console.log(JSON.stringify(deDuplicatedApplications[0], null, 2));
    }
    console.log("=================================================");
    return { processed: deDuplicatedApplications.length, inserted: 0, updated: 0, skipped: 0 };
  } else {
    // A. Insert Operators
    if (operatorsToInsert.length > 0) {
      console.log("\nInserting operator accounts to 'users' table...");
      const { error: insErr } = await db.from('users').insert(operatorsToInsert);
      if (insErr) {
        console.error("❌ Failed to insert operators:", insErr.message);
      } else {
        console.log(`⚡ Registered ${operatorsToInsert.length} operator accounts successfully.`);
      }
    }

    // B. Insert/Update Refund Applications (Batching of 200 items to fit PostgREST size limits)
    console.log(`\nProcessing ${deDuplicatedApplications.length} refund applications...`);
    const batchSize = 200;
    let insertedCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;

    for (let i = 0; i < deDuplicatedApplications.length; i += batchSize) {
      const batch = deDuplicatedApplications.slice(i, i + batchSize);
      
      const batchTickets = batch.map(a => a.ticket_number);
      const { data: existingApps, error: chkErr } = await db
        .from('refund_applications')
        .select('*')
        .in('ticket_number', batchTickets);

      if (chkErr) {
        console.error("❌ Conflict checking failed:", chkErr.message);
        continue;
      }

      const existingMap = new Map(existingApps.map(a => [
        `${a.ticket_number}_${a.bsp_request_number || ''}_${a.tch_request_number || ''}`,
        a
      ]));

      const toInsert = [];
      const toUpdate = [];

      for (const app of batch) {
        const key = `${app.ticket_number}_${app.bsp_request_number || ''}_${app.tch_request_number || ''}`;
        const dbApp = existingMap.get(key);
        if (!dbApp) {
          toInsert.push(app);
        } else {
          // Check if fields changed
          const hasChanged = 
            app.status !== dbApp.status ||
            app.amount !== dbApp.amount ||
            app.currency !== dbApp.currency ||
            app.is_archived !== dbApp.is_archived ||
            app.agent_name !== dbApp.agent_name ||
            (app.agent_refund_equivalent !== null && dbApp.agent_refund_equivalent !== null ? 
             Math.abs(app.agent_refund_equivalent - dbApp.agent_refund_equivalent) > 0.01 : 
             app.agent_refund_equivalent !== dbApp.agent_refund_equivalent) ||
            app.support_ticket !== dbApp.support_ticket;

          if (hasChanged) {
            toUpdate.push({ app, dbApp });
          } else {
            skippedCount++;
          }
        }
      }

      // 1. Perform Inserts
      if (toInsert.length > 0) {
        const insertPayload = toInsert.map(({ comment, ...rest }) => rest);

        const { data: insertedApps, error: insertAppsErr } = await db
          .from('refund_applications')
          .insert(insertPayload)
          .select('id, ticket_number, status, requested_by, bsp_request_number, tch_request_number');

        if (insertAppsErr) {
          console.error(`❌ Batch insert failed [${i} to ${i + batch.length}]:`, insertAppsErr.message);
        } else {
          insertedCount += toInsert.length;

          // Insert comments into status_history
          if (insertedApps && insertedApps.length > 0) {
            const historyBatch = [];
            for (const app of insertedApps) {
              const original = toInsert.find(a => 
                a.ticket_number === app.ticket_number &&
                (a.bsp_request_number || '') === (app.bsp_request_number || '') &&
                (a.tch_request_number || '') === (app.tch_request_number || '')
              );
              const commentText = original && original.comment ? original.comment : 'Импорт из Google Sheets';
              historyBatch.push({
                application_id: app.id,
                old_status: null,
                new_status: app.status,
                changed_by: app.requested_by || 'Система',
                comment: commentText
              });
            }
            if (historyBatch.length > 0) {
              const { error: histErr } = await db.from('status_history').insert(historyBatch);
              if (histErr) {
                console.error(`  ⚠️ Warning: status history insert failed for batch:`, histErr.message);
              }
            }
          }
        }
      }

      // 2. Perform Updates
      if (toUpdate.length > 0) {
        for (const { app, dbApp } of toUpdate) {
          const { comment, ...updatePayload } = app;
          const { error: updateErr } = await db
            .from('refund_applications')
            .update(updatePayload)
            .eq('id', dbApp.id);

          if (updateErr) {
            console.error(`❌ Update failed for ticket ${app.ticket_number}:`, updateErr.message);
          } else {
            updatedCount++;
            
            if (app.status !== dbApp.status || app.is_archived !== dbApp.is_archived) {
              const oldStatusDesc = dbApp.is_archived ? `${dbApp.status} (Архив)` : dbApp.status;
              const newStatusDesc = app.is_archived ? `${app.status} (Архив)` : app.status;
              
              const { error: histErr } = await db
                .from('status_history')
                .insert([
                  {
                    application_id: dbApp.id,
                    old_status: oldStatusDesc,
                    new_status: newStatusDesc,
                    changed_by: app.requested_by || 'Система',
                    comment: app.comment || 'Изменение параметров при синхронизации'
                  }
                ]);
              if (histErr) console.error(`  ⚠️ Warning: status history update failed for ${app.ticket_number}:`, histErr.message);
            }
          }
        }
      }
    }

    console.log(`\n⚡ Sync completed!`);
    console.log(`   Processed: ${deDuplicatedApplications.length}`);
    console.log(`   Imported (new): ${insertedCount}`);
    console.log(`   Updated (changed): ${updatedCount}`);
    console.log(`   Skipped (no change): ${skippedCount}`);

    return {
      processed: deDuplicatedApplications.length,
      inserted: insertedCount,
      updated: updatedCount,
      skipped: skippedCount
    };
  }
}

if (require.main === module) {
  run().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  run
};
