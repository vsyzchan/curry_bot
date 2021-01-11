const TelegramBot = require('node-telegram-bot-api')
const { token, ownerUserId, ownerUsername, maxSizeOfTaskQueue, userIdWhiteList } = require('../config.json')
const utils = require('./utils')

class Bot {
  constructor (token) {
    this._bot = new TelegramBot(token)
    this._userId = null
    this._username = null
    this._pending = {}
  }

  async startPolling () {
    await this._initInfo()
    this._startHandlingHelpRequests()
    this._startHandlingStaticStickerRequests()
    this._bot.startPolling()
      .catch(error => {
        console.log(error)
      })
  }

  async _initInfo () {
    if (this._userId && this._username) {
      return
    }
    const info = await this._bot.getMe()
      .catch(error => {
        console.log(error)
      })
    this._userId = info.id
    this._username = info.username
  }

  async _sendEditableMessage (chatId, text, options) {
    const { message_id: messageId } = await this._bot.sendMessage(chatId, text, options)
      .catch(error => {
        console.log(error)
      })
    return (newText) => {
      return this._bot.editMessageText(newText, {
        chat_id: chatId,
        message_id: messageId
      })
        .catch(error => {
          console.log(error)
        })
    }
  }

  _startHandlingHelpRequests () {
    this._bot.onText(/\/(help)|(start)/, async msg => {
      const chatId = msg.chat.id
      const helpMessage = [
        `Hi！@${this._username}, untuk mengambil stiker dari LINE gunakan command /steal <Sticker ID>`
      ].join('\n')
      await this._bot.sendMessage(chatId, helpMessage)
    })
  }

  _startHandlingStaticStickerRequests () {
    this._bot.onText(/\/steal (\d+)/, async (msg, match) => {
      const chatId = msg.chat.id
      const requestUserId = msg.from.id
      const requestMessageId = msg.message_id
      const staticStickerId = match[1]
      if (requestUserId !== ownerUserId && !userIdWhiteList.includes(requestUserId)) {
        await this._bot.sendMessage(chatId, `Kamu tidak memiliki izin untuk menggunakan robot ini!\nSilahkan hubungi @${ownerUsername}`)
        return
      } else if (this._pending[requestUserId]) {
        await this._bot.sendMessage(chatId, 'Hanya satu paket stiker yang dapat diunduh dalam satu waktu')
        return
      } else if (Object.keys(this._pending).length >= maxSizeOfTaskQueue) {
        await this._bot.sendMessage(chatId, 'Terlalu banyak pengguna saat ini! Silahkan coba lagi nanti')
        return
      }
      this._pending[requestUserId] = true
      await this._handleStaticStickerRequest(chatId, requestMessageId, staticStickerId)
      delete this._pending[requestUserId]
    })
  }

  async _handleStaticStickerRequest (chatId, requestMessageId, staticStickerId) {
    const updateEditableMessage = await this._sendEditableMessage(chatId, 'Request diterima!', {
      reply_to_message_id: requestMessageId
    })
    try {
      const zipUrl = utils.getStaticStickerZipUrl(staticStickerId)
      const zipDirectory = await utils.openZipByUrl(zipUrl)
        .catch(error => {
          console.log(error)
          updateEditableMessage(`Gagal: file paket stiker tidak dapat ditemukan!\n\nCoba porting paket stiker untuk ID：${staticStickerId}`)
          throw new Error('Interrupt')
        })
      const meta = await utils.fetchMeta(zipDirectory)
        .catch(error => {
          console.log(error)
          updateEditableMessage(`Porting gagal: tidak dapat mengurai informasi paket stiker\n\nCoba porting paket stiker untuk ID：${staticStickerId}`)
          throw new Error('Interrupt')
        })
      if (meta.hasAnimation) {
        await updateEditableMessage('Saat ini tidak ada dukungan untuk porting "Stiker Animasi"!')
        return
      } else if (meta.stickerResourceType && meta.stickerResourceType === 'NAME_TEXT') {
        await updateEditableMessage('Saat ini tidak ada dukungan untuk porting "Stiker Custom Text"!')
        return
      }
      const stickerSetName = `static_${staticStickerId}_by_${this._username}`
      const stickerSetTitle = `${meta.title['zh-Hant'] || meta.title.en}`
      let stickerSet = await this._bot.getStickerSet(stickerSetName).catch(_ => null)
      if (!stickerSet) {
        const stickerImageFiles = utils.filterStaticStickerImageFiles(zipDirectory)
        const stickerSetCreatingTasks = stickerImageFiles.map((file, index) => {
          const task = async () => {
            await updateEditableMessage(`Paket stiker "${stickerSetTitle}" porting (${index}/${stickerImageFiles.length})`)
            let imageBuffer = await file.buffer()
              .catch(async error => {
                console.log(error)
                await updateEditableMessage(`Porting gagal: tidak dapat memperoleh tekstur stiker dengan benar\n\nCoba porting paket stiker untuk ID：${staticStickerId}\nFile stiker yang gagal adalah：${file.path}`)
                throw new Error('Interrupt')
              })
            imageBuffer = await utils.resizePNG(imageBuffer)
              .catch(async error => {
                console.log(error)
                await updateEditableMessage(`Gagal! Tidak dapat menyesuaikan ukuran tekstur stiker dengan benar\n\nCoba porting paket stiker untuk ID：${staticStickerId}\nFile stiker yang gagal adalah：${file.path}`)
                throw new Error('Interrupt')
              })
            if (index === 0) {
              await this._bot.createNewStickerSet(ownerUserId, stickerSetName, stickerSetTitle, imageBuffer, '😊')
            } else {
              await this._bot.addStickerToSet(ownerUserId, stickerSetName, imageBuffer, '😊')
            }
          }
          return task
        })
        while (stickerSetCreatingTasks.length) {
          const task = stickerSetCreatingTasks.shift()
          await task()
        }
        stickerSet = await this._bot.getStickerSet(stickerSetName).catch(_ => null)
        await updateEditableMessage(`Stiker "${stickerSetTitle}" berhasil diunduh!`)
      } else {
        await updateEditableMessage(`Stiker "${stickerSetTitle}" sudah diunduh!`)
      }

      const stickerToSend = stickerSet.stickers[0].file_id
      await this._bot.sendSticker(chatId, stickerToSend, {
        reply_to_message_id: requestMessageId
      })
    } catch (error) {
      if (error.message && error.message === 'Interrupt') {
        return
      }
      console.log(error)
      await updateEditableMessage(`Gagal! Kesalahan tidak diketahui\n${error.message ? `\n${error.message}\n` : ''}\nSilahkan lapor ke @${ownerUsername}`)
    }
  }
}

module.exports = new Bot(token)
