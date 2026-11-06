import QRCode from '../vendor/qrcode-terminal/QRCode/index.js'
import { encodePng } from './png.js'

/** Render the login link as a PNG data URL without temporary files. */
export async function qrDataUrl(text) {
  const qr = new QRCode(-1, 1) // error correction level L
  qr.addData(text)
  qr.make()
  const png = encodePng(qr.modules, { scale: 12, border: 4 })
  return `data:image/png;base64,${png.toString('base64')}`
}
