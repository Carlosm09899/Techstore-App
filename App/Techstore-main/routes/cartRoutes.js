const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const Cart = require('../models/cart');
const User = require('../models/user');

const router = express.Router();

function getUserId(req, res) {
  const token = req.cookies.auth_token || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token || !process.env.JWT_SECRET) {
    res.status(401).json({message: 'Inicia sesión para usar tu carrito'});
    return null;
  }
  try {
    return jwt.verify(token, process.env.JWT_SECRET).id;
  } catch {
    res.status(401).json({message: 'La sesión expiró'});
    return null;
  }
}

function getProductModel() {
  return mongoose.model('Producto');
}

async function getCart(userId) {
  const cart = await Cart.findOne({userId}).lean();
  return cart || {userId, items: [], version: 0};
}

function responseCart(cart) {
  const items = (cart.items || []).map(item => ({
    productId: String(item.productId),
    sku: item.sku || '',
    name: item.name,
    image: item.image || '',
    price: item.price,
    quantity: item.quantity,
    equipmentId: item.equipmentId ? String(item.equipmentId) : undefined,
    equipmentName: item.equipmentName || undefined,
    compatibilityMessage: item.compatibilityMessage || undefined
  }));
  return {
    userId: String(cart.userId),
    items,
    count: items.reduce((sum, item) => sum + item.quantity, 0),
    total: items.reduce((sum, item) => sum + item.price * item.quantity, 0),
    updatedAt: cart.updatedAt || null
  };
}

async function loadProduct(productId) {
  if (!mongoose.Types.ObjectId.isValid(productId)) return null;
  return getProductModel().findOne({_id: productId, activo: true}).lean();
}

function validateQuantity(value) {
  const quantity = Number(value);
  return Number.isInteger(quantity) && quantity > 0 && quantity <= 999 ? quantity : null;
}

function publishCart(req, userId, cart) {
  req.app.get('io')?.to(`cart:${userId}`).emit('cart:updated', {cart: responseCart(cart)});
}

router.get('/', async (req, res) => {
  const userId = getUserId(req, res);
  if (!userId) return;
  try {
    res.json({cart: responseCart(await getCart(userId))});
  } catch (error) {
    console.error('Error al obtener el carrito:', error.message);
    res.status(500).json({message: 'No se pudo obtener el carrito'});
  }
});

router.post('/items', async (req, res) => {
  const userId = getUserId(req, res);
  if (!userId) return;
  const productId = String(req.body.productId || '');
  const quantity = validateQuantity(req.body.quantity || 1);
  if (!quantity) return res.status(400).json({message: 'La cantidad no es válida'});
  try {
    const product = await loadProduct(productId);
    if (!product) return res.status(404).json({message: 'El producto no está disponible'});
    const equipmentId = req.body.equipmentId && mongoose.Types.ObjectId.isValid(req.body.equipmentId)
      ? new mongoose.Types.ObjectId(req.body.equipmentId) : undefined;
    const user = await User.findById(userId).select('equipos').lean();
    if (equipmentId && !user?.equipos?.some(item => String(item._id) === String(equipmentId))) {
      return res.status(400).json({message: 'El equipo seleccionado no pertenece a tu cuenta'});
    }

    const cart = await Cart.findOneAndUpdate(
      {userId},
      {$setOnInsert: {userId, items: []}},
      {upsert: true, new: true}
    );
    const existing = cart.items.find(item => String(item.productId) === productId && String(item.equipmentId || '') === String(equipmentId || ''));
    const nextQuantity = (existing?.quantity || 0) + quantity;
    if (!Number.isInteger(product.stock) || product.stock < nextQuantity) {
      return res.status(409).json({message: `No hay stock suficiente para ${product.nombre}`});
    }
    if (existing) {
      existing.quantity = nextQuantity;
      existing.price = product.precio;
      existing.name = product.nombre;
      existing.image = product.imagen_url || '';
    } else {
      cart.items.push({
        productId: product._id,
        name: product.nombre,
        image: product.imagen_url || '',
        price: product.precio,
        quantity,
        equipmentId,
        equipmentName: req.body.equipmentName,
        compatibilityMessage: req.body.compatibilityMessage
      });
    }
    await cart.save();
    publishCart(req, userId, cart);
    res.status(201).json({cart: responseCart(cart)});
  } catch (error) {
    console.error('Error al agregar al carrito:', error.message);
    res.status(500).json({message: 'No se pudo actualizar el carrito'});
  }
});

router.patch('/items/:productId', async (req, res) => {
  const userId = getUserId(req, res);
  if (!userId) return;
  const quantity = validateQuantity(req.body.quantity);
  if (!quantity) return res.status(400).json({message: 'La cantidad no es válida'});
  try {
    const product = await loadProduct(req.params.productId);
    if (!product) return res.status(404).json({message: 'El producto no está disponible'});
    if (product.stock < quantity) return res.status(409).json({message: `No hay stock suficiente para ${product.nombre}`});
    const cart = await Cart.findOne({userId});
    if (!cart) return res.status(404).json({message: 'El carrito está vacío'});
    const item = cart.items.find(entry => String(entry.productId) === req.params.productId && String(entry.equipmentId || '') === String(req.body.equipmentId || ''));
    if (!item) return res.status(404).json({message: 'El producto no está en el carrito'});
    item.quantity = quantity;
    item.price = product.precio;
    await cart.save();
    publishCart(req, userId, cart);
    res.json({cart: responseCart(cart)});
  } catch (error) {
    console.error('Error al actualizar el carrito:', error.message);
    res.status(500).json({message: 'No se pudo actualizar el carrito'});
  }
});

router.delete('/items/:productId', async (req, res) => {
  const userId = getUserId(req, res);
  if (!userId) return;
  try {
    const cart = await Cart.findOne({userId});
    if (!cart) return res.json({cart: responseCart({userId, items: []})});
    cart.items = cart.items.filter(item => !(String(item.productId) === req.params.productId && String(item.equipmentId || '') === String(req.query.equipmentId || '')));
    await cart.save();
    publishCart(req, userId, cart);
    res.json({cart: responseCart(cart)});
  } catch (error) {
    console.error('Error al eliminar del carrito:', error.message);
    res.status(500).json({message: 'No se pudo eliminar el producto'});
  }
});

router.delete('/', async (req, res) => {
  const userId = getUserId(req, res);
  if (!userId) return;
  try {
    const cart = await Cart.findOneAndUpdate({userId}, {$set: {items: []}}, {new: true, upsert: true});
    publishCart(req, userId, cart);
    res.json({cart: responseCart(cart)});
  } catch (error) {
    console.error('Error al vaciar el carrito:', error.message);
    res.status(500).json({message: 'No se pudo vaciar el carrito'});
  }
});

module.exports = {router, responseCart};
