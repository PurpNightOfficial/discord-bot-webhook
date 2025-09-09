const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const express = require('express');

// 環境變數
const token = process.env.BOT_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'your-secret-key';
const GOOGLE_SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL;

if (!token) {
    console.error('❌ BOT_TOKEN 未設定！');
    process.exit(1);
}

console.log(`✅ Bot Token 已設定，長度: ${token.length}`);

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Express 伺服器設定
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

// 首頁
app.get('/', (req, res) => {
    res.json({
        status: 'Discord Bot is running! 🤖',
        uptime: Math.floor(process.uptime()),
        guilds: client.guilds ? client.guilds.cache.size : 0
    });
});

// Webhook 端點 - 接收 Google Apps Script 請求
app.post('/webhook', async (req, res) => {
    try {
        const { secret, channelId, type, data } = req.body;
        
        // 驗證 secret
        if (secret !== WEBHOOK_SECRET) {
            return res.status(401).json({ error: '未授權' });
        }

        if (!channelId || !type || !data) {
            return res.status(400).json({ error: '缺少必要參數' });
        }

        const channel = await client.channels.fetch(channelId);
        if (!channel) {
            return res.status(404).json({ error: '找不到頻道' });
        }

        // 根據類型發送不同的訊息
        let messageData;
        
        switch (type) {
            case 'approval':
                messageData = await createApprovalMessage(data);
                break;
            case 'notification':
                messageData = await createNotificationMessage(data);
                break;
            case 'survey':
                messageData = await createSurveyMessage(data);
                break;
            default:
                return res.status(400).json({ error: '不支援的訊息類型' });
        }

        const message = await channel.send(messageData);
        
        console.log(`✅ 訊息已發送到 ${channel.name}: ${message.id}`);
        res.json({ 
            success: true, 
            messageId: message.id,
            channelName: channel.name 
        });

    } catch (error) {
        console.error('❌ Webhook 處理錯誤:', error);
        res.status(500).json({ error: '內部伺服器錯誤' });
    }
});

// 建立審批訊息
async function createApprovalMessage(data) {
    const embed = new EmbedBuilder()
        .setTitle('📋 ' + (data.title || '需要審批'))
        .setDescription(data.description || '請審核以下內容')
        .setColor(0x3498db)
        .setTimestamp();

    if (data.fields) {
        data.fields.forEach(field => {
            embed.addFields({ 
                name: field.name, 
                value: field.value, 
                inline: field.inline || false 
            });
        });
    }

    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`approve_${data.id}`)
                .setLabel('✅ 同意')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`reject_${data.id}`)
                .setLabel('❌ 拒絕')
                .setStyle(ButtonStyle.Danger)
        );

    return { embeds: [embed], components: [row] };
}

// 建立通知訊息
async function createNotificationMessage(data) {
    const embed = new EmbedBuilder()
        .setTitle('📢 ' + (data.title || '通知'))
        .setDescription(data.description || '這是一則通知')
        .setColor(0xf39c12)
        .setTimestamp();

    if (data.fields) {
        data.fields.forEach(field => {
            embed.addFields({ 
                name: field.name, 
                value: field.value, 
                inline: field.inline || false 
            });
        });
    }

    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`confirm_${data.id}`)
                .setLabel('👍 已讀')
                .setStyle(ButtonStyle.Primary)
        );

    return { embeds: [embed], components: [row] };
}

// 建立問卷訊息
async function createSurveyMessage(data) {
    const embed = new EmbedBuilder()
        .setTitle('📊 ' + (data.title || '問卷調查'))
        .setDescription(data.description || '請選擇您的回答')
        .setColor(0x9b59b6)
        .setTimestamp();

    const row = new ActionRowBuilder();
    
    if (data.options && data.options.length > 0) {
        data.options.forEach((option, index) => {
            if (index < 5) { // Discord 限制每行最多5個按鈕
                row.addComponents(
                    new ButtonBuilder()
                        .setCustomId(`survey_${data.id}_${index}`)
                        .setLabel(option.label)
                        .setStyle(ButtonStyle.Secondary)
                );
            }
        });
    }

    return { embeds: [embed], components: [row] };
}

// Bot 事件處理
client.once('ready', () => {
    console.log(`✅ Bot 已登入: ${client.user.tag}`);
    console.log(`📊 已連接到 ${client.guilds.cache.size} 個伺服器`);
});

// 處理按鈕點擊
client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;

    try {
        await interaction.deferReply({ ephemeral: true });

        const [action, id, optionIndex] = interaction.customId.split('_');
        const userId = interaction.user.id;
        const userName = interaction.user.displayName || interaction.user.username;
        
        let responseData = {
            action,
            id,
            userId,
            userName,
            timestamp: new Date().toISOString(),
            guildId: interaction.guildId,
            channelId: interaction.channelId,
            messageId: interaction.message.id
        };

        // 根據不同動作準備資料
        switch (action) {
            case 'approve':
                responseData.decision = 'approved';
                break;
            case 'reject':
                responseData.decision = 'rejected';
                break;
            case 'confirm':
                responseData.decision = 'confirmed';
                break;
            case 'survey':
                responseData.optionIndex = optionIndex;
                responseData.decision = 'survey_response';
                break;
        }

        // 發送資料到 Google Apps Script
        if (GOOGLE_SCRIPT_URL) {
            try {
                const fetch = (await import('node-fetch')).default;
                const response = await fetch(GOOGLE_SCRIPT_URL, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(responseData)
                });

                if (response.ok) {
                    console.log('✅ 資料已發送到 Google Sheets');
                    await interaction.editReply('✅ 回應已記錄！');
                } else {
                    console.error('❌ Google Sheets 回應錯誤:', response.status);
                    await interaction.editReply('⚠️ 回應已收到，但記錄時發生問題。');
                }
            } catch (error) {
                console.error('❌ 發送到 Google Sheets 失敗:', error);
                await interaction.editReply('⚠️ 回應已收到，但記錄時發生網路問題。');
            }
        } else {
            console.log('📝 模擬記錄:', responseData);
            await interaction.editReply('✅ 回應已記錄！（模擬模式）');
        }

        // 更新原始訊息（可選）
        try {
            const embed = interaction.message.embeds[0];
            if (embed) {
                const updatedEmbed = EmbedBuilder.from(embed)
                    .setFooter({ text: `最後回應：${userName} (${new Date().toLocaleString('zh-TW')})` });
                
                await interaction.message.edit({ 
                    embeds: [updatedEmbed], 
                    components: interaction.message.components 
                });
            }
        } catch (error) {
            console.error('更新訊息失敗:', error);
        }

    } catch (error) {
        console.error('❌ 按鈕處理錯誤:', error);
        try {
            await interaction.editReply('❌ 處理回應時發生錯誤。');
        } catch (e) {
            console.error('回覆錯誤訊息失敗:', e);
        }
    }
});

// 基本指令
client.on('messageCreate', message => {
    if (message.author.bot) return;

    if (message.content === '!ping') {
        message.channel.send('Pong! 🏓');
    }

    if (message.content === '!test-webhook') {
        message.channel.send(`測試 Webhook URL: ${req.protocol}://${req.get('host')}/webhook\nChannel ID: ${message.channel.id}`);
    }
});

// 錯誤處理
client.on('error', console.error);

// 啟動 Bot
client.login(token).catch(error => {
    console.error('❌ Bot 登入失敗:', error.message);
    process.exit(1);
});

// 啟動 Express 伺服器
app.listen(PORT, () => {
    console.log(`🚀 Webhook 伺服器運行在 port ${PORT}`);
    console.log(`📡 Webhook 端點: /webhook`);
});
