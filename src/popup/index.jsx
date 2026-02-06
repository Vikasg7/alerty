/** @jsx Preact.h */

import * as Preact from '../lib/preact.module.js'
import { Fragment } from '../lib/preact.module.js'
import { useEffect, useRef, useState } from '../lib/preact-hooks.module.js'
import { signal, computed, batch } from '../lib/preact-signals.module.js'

globalThis.chrome = globalThis.browser ? globalThis.browser : globalThis.chrome

const POPUP_PATH = chrome.runtime.getURL("popup/index.html")

async function sleep(seconds) {
   return new Promise((resolve) => setTimeout(resolve, seconds * 1000))
}

const toINR = (number) => (
   number.toLocaleString('en-IN', {
      maximumFractionDigits: 0,
      style: 'currency',
      currency: 'INR'
   })
)

// Retry once after a second to handle "Error: Could not establish connection. Receiving end does not exist."
async function sendMsg(msg) {
   try {
      await chrome.runtime.sendMessage(msg)
   } catch (e) {
      await sleep(1)
      await chrome.runtime.sendMessage(msg)
   }
}

function isEmpty(obj) {
   for (let key in obj) return false;
   return true
}

function discount(listing) {
   const discount = listing.price.last - listing.price.curr 
   return discount > 0 ? discount : 0
}

function createStore() {
   const Listings = signal({}),
         isLoading = signal(false),
         alertText = signal(""),
         searchText = signal(""),
         sortBy = signal("recent"),
         isRefreshing = signal(false),
         toBeRemoved = signal([]);
   const FilteredSorted = computed(() => {
      const filtered = 
         Object.values(Listings.value)
         .filter((listing) => listing.title.toLowerCase().includes(searchText.value.toLowerCase()))
      
      // Sort based on selected option
      switch(sortBy.value) {
         case "discount":
            return filtered.sort((a, b) => discount(b) - discount(a))
         case "price-low":
            return filtered.sort((a, b) => a.price.curr - b.price.curr)
         case "price-high":
            return filtered.sort((a, b) => b.price.curr - a.price.curr)
         case "name":
            return filtered.sort((a, b) => a.title.localeCompare(b.title))
         case "recent":
         default:
            return filtered.sort((a, b) => b.time - a.time)
      }
   })
   return { Listings, isLoading, alertText, searchText, FilteredSorted, sortBy, isRefreshing, toBeRemoved }
}

const Store = createStore()

const initializeApp = async () => {
   setLoading(true)
   const { IsRefreshing } = await chrome.storage.sync.get(["IsRefreshing"])
   const { SortBy } = await chrome.storage.sync.get(["SortBy"])
   const { Listings } = await chrome.storage.sync.get(["Listings"])
   batch(() => {
      setRefreshing(IsRefreshing)
      setSortBy(SortBy || "recent")
      updateListings(Listings)
      setLoading(false)
   })
}

// Actions
const updateListings = (list) => { Store.Listings.value = list }
const setLoading     = (bool) => { Store.isLoading.value = bool }
const setAlertText   = (text) => { Store.alertText.value = text }
const setSearchText  = (text) => { Store.searchText.value = text}
const setSortBy      = (val) => { Store.sortBy.value = val }
const setRefreshing  = (bool) => { Store.isRefreshing.value = bool }

// Handlers
const closeAlert = (event) => {
   event.preventDefault()
   setAlertText("")
}

const handleAdd = (event) => {
   event.preventDefault()
   !Store.isLoading.value && sendMsg({ action: "AddListing" })
   setLoading(true)
}

const handleDel = (listing) => (event) => {
   event.preventDefault()
   sendMsg({ action: "DelListing", key: listing.key })
}

const handlePullToRefresh = () => {
   if (!Store.isLoading.value && !Store.isRefreshing.value) {
      console.log("Pull to refresh triggered")
      sendMsg({ action: "RefreshListings" })
   }
}

const handleMsg = (msg) => {
   switch (msg.action) {
      case "Listings": {
         batch(() => {
            updateListings(msg.Listings)
            setLoading(false)
         })
         break
      }
      case "Error": {
         batch(() => {
            setAlertText(msg.error)
            setLoading(false)
         })
         break
      }
      case "IsRefreshing": {
         setRefreshing(msg.IsRefreshing)
         break
      }
   }
}

const handleInput = (event) => {
   event.preventDefault()
   setSearchText(event.target.value)
}

const handleSortChange = async (eventOrValue) => {
   const value = typeof eventOrValue === "string"
      ? eventOrValue
      : eventOrValue?.target?.value
   await chrome.storage.sync.set({ SortBy: value })
   setSortBy(value)
}

const handleCopyLink = (url) => async (event) => {
   event.preventDefault()
   await navigator.clipboard.writeText(url)
   setAlertText("Product link copied to the clipboard")
}

const handleSearchToggle = (showSearchBar, isShowing) => (event) => {
   if (event) event.preventDefault()
   if (isShowing) {
      setSearchText("")
   }
   showSearchBar(!isShowing)
}

const onAppMount = () => {
   chrome.runtime.onMessage.addListener(handleMsg)
   initializeApp()
   console.log("onAppMount: Registered message listener and initialized app")
   // on App Un-mount
   return () => chrome.runtime.onMessage.removeListener(handleMsg)
}

const onSearchBarMount = (inputRef) => () => {
   inputRef.current?.focus()
}

// Dumb components
const Spinner = () => (
   <div className="spinner-overlay">
      <i className="fa-solid fa-spinner fa-spin"></i>
   </div>
)

const Alert = ({ msg, onClose }) => (
   <div className="alert-overlay">
      <div className="alert-box" role="status" aria-live="polite">
         <div className="alert-content">
            <div className="alert-icon">
               <i className="fa-solid fa-circle-info" aria-hidden="true"></i>
            </div>
            <div className="alert-text">{msg}</div>
         </div>
         <button className="alert-close" onClick={onClose} aria-label="Dismiss alert">
            <i className="fa-solid fa-xmark" aria-hidden="true"></i>
         </button>
      </div>
   </div>
)

const DelConfirmation = ({ onOk, onClose }) => (
   <div className="confirm-overlay">
      <div className="confirm-box">
         <div className="confirm-text">Click <i className="fa-solid fa-check"></i> to remove the listing</div>
         <div className="confirm-actions">
            <i className="fa-solid fa-check clickable" onClick={onOk}></i>
            <i className="fa-solid fa-xmark clickable" onClick={onClose}></i>
         </div>
      </div>
   </div>
)

function SearchBar({ isActive }) {
   const { searchText } = Store
   const inputRef = useRef(null)
   useEffect(onSearchBarMount(inputRef), [isActive])
   return (
      <div className={`search-container ${isActive ? 'active' : ''}`}>
         <i className="fa-solid fa-magnifying-glass search-icon"></i>
         <input 
            className="search-input" 
            ref={inputRef} 
            type="search" 
            placeholder="Search your tracked items..." 
            value={searchText.value} 
            onInput={handleInput} 
         />
      </div>
   )
}

function PullToRefresh({ children }) {
   const [pullDistance, setPullDistance] = useState(0)
   const [isRefreshing, setIsRefreshing] = useState(false)
   const containerRef = useRef(null)
   const startY = useRef(0)
   const isDragging = useRef(false)
   const pullDistanceRef = useRef(0)
   const isRefreshingRef = useRef(false)
   const wheelTimeoutRef = useRef(null)
   const PULL_THRESHOLD = 110
   const PULL_MAX = 140
   const DRAG_START = 12

   const updatePullDistance = (distance) => {
      pullDistanceRef.current = distance
      setPullDistance(distance)
   }

   const updateRefreshing = (value) => {
      isRefreshingRef.current = value
      setIsRefreshing(value)
   }

   const handleTouchStart = (e) => {
      if (containerRef.current.scrollTop === 0) {
         startY.current = e.touches[0].clientY
         isDragging.current = true
      }
   }

   const handleTouchMove = (e) => {
      if (!isDragging.current) return
      
      const currentY = e.touches[0].clientY
      const distance = currentY - startY.current
      
      if (distance > 0 && containerRef.current.scrollTop === 0) {
         e.preventDefault()
         if (distance > DRAG_START) {
            updatePullDistance(Math.min(distance, PULL_MAX))
         }
      }
   }

   const handleTouchEnd = async () => {
      if (!isDragging.current) return
      
      if (pullDistanceRef.current > PULL_THRESHOLD) {
         updateRefreshing(true)
         updatePullDistance(0)
         handlePullToRefresh()
         
         // Wait for refresh to complete
         setTimeout(() => {
            updateRefreshing(false)
         }, 1500)
      } else {
         updatePullDistance(0)
      }
      
      isDragging.current = false
   }

   const handleMouseDown = (e) => {
      if (e.button !== 0) return
      if (containerRef.current.scrollTop === 0) {
         startY.current = e.clientY
         isDragging.current = true
      }
   }

   const handleMouseMove = (e) => {
      if (!isDragging.current) return
      
      const currentY = e.clientY
      const distance = currentY - startY.current
      
      if (distance > 0 && containerRef.current.scrollTop === 0) {
         e.preventDefault()
         if (distance > DRAG_START) {
            updatePullDistance(Math.min(distance, PULL_MAX))
         }
      }
   }

   const handleMouseUp = async () => {
      if (!isDragging.current) return
      
      if (pullDistanceRef.current > PULL_THRESHOLD) {
         updateRefreshing(true)
         updatePullDistance(0)
         handlePullToRefresh()
         
         setTimeout(() => {
            updateRefreshing(false)
         }, 1500)
      } else {
         updatePullDistance(0)
      }
      
      isDragging.current = false
   }

   const handleWheel = (e) => {
      if (!containerRef.current) return
      if (containerRef.current.scrollTop !== 0) return
      if (e.deltaY >= 0) return

      e.preventDefault()
      const nextDistance = Math.min(pullDistanceRef.current + Math.abs(e.deltaY) * 0.35, PULL_MAX)
      updatePullDistance(nextDistance)

      if (wheelTimeoutRef.current) clearTimeout(wheelTimeoutRef.current)
      wheelTimeoutRef.current = setTimeout(() => {
         if (pullDistanceRef.current > PULL_THRESHOLD) {
            updateRefreshing(true)
            updatePullDistance(0)
            handlePullToRefresh()
            setTimeout(() => {
               updateRefreshing(false)
            }, 1500)
         } else {
            updatePullDistance(0)
         }
      }, 120)
   }

   useEffect(() => {
      const container = containerRef.current
      if (!container) return

      container.addEventListener('touchstart', handleTouchStart, { passive: false })
      container.addEventListener('touchmove', handleTouchMove, { passive: false })
      container.addEventListener('touchend', handleTouchEnd, { passive: true })
      container.addEventListener('touchcancel', handleTouchEnd, { passive: true })
      container.addEventListener('mousedown', handleMouseDown)
      container.addEventListener('wheel', handleWheel, { passive: false })
      window.addEventListener('mousemove', handleMouseMove)
      window.addEventListener('mouseup', handleMouseUp)

      return () => {
         container.removeEventListener('touchstart', handleTouchStart)
         container.removeEventListener('touchmove', handleTouchMove)
         container.removeEventListener('touchend', handleTouchEnd)
         container.removeEventListener('touchcancel', handleTouchEnd)
         container.removeEventListener('mousedown', handleMouseDown)
         container.removeEventListener('wheel', handleWheel)
         window.removeEventListener('mousemove', handleMouseMove)
         window.removeEventListener('mouseup', handleMouseUp)
      }
   }, [])

   const showRefreshing = isRefreshing || Store.isRefreshing.value
   const bannerHeight = showRefreshing ? 60 : Math.min(pullDistance, 60)
   const bannerOpacity = showRefreshing ? 1 : Math.min(pullDistance / 60, 1)

   return (
      <div className="pull-to-refresh-container" ref={containerRef}>
         <div className="pull-spacer" style={{ height: showRefreshing ? 60 : pullDistance }}>
            <div
               className={`pull-to-refresh-indicator ${showRefreshing ? 'refreshing' : ''}`}
               style={{ height: bannerHeight, opacity: bannerOpacity }}
            >
               {showRefreshing ? (
                  <Fragment>
                     <i className="fa-solid fa-arrows-rotate fa-spin"></i>
                     <span>Refreshing...</span>
                  </Fragment>
               ) : pullDistance > 60 ? (
                  <Fragment>
                     <i className="fa-solid fa-arrows-rotate"></i>
                     <span>Release to refresh</span>
                  </Fragment>
               ) : (
                  <Fragment>
                     <i className="fa-solid fa-arrow-down"></i>
                     <span>Pull to refresh</span>
                  </Fragment>
               )}
            </div>
         </div>
         {children}
      </div>
   )
}

function Listing({ listing }) {
   const change = listing.price.curr - listing.price.last
   const [isConfirming, showConfirm] = useState(false)
   const source = listing.url.includes('amazon') ? 'Amazon' : listing.url.includes('flipkart') ? 'Flipkart' : 'Unknown'
   
   return (
      <div className="product-card">
         {isConfirming && <DelConfirmation onOk={handleDel(listing)} onClose={() => showConfirm(false)}/>}
         
         <div className="product-image-container">
            <img className="product-image" src={listing.image} alt="Product" />
         </div>
         
         <div className="product-info">
            <div className="product-meta">
               <span className="store-name">{source}</span>
            </div>

            <div className="product-header">
               <h3 className="product-title">
                  <a href={listing.url} target="_blank" title={listing.title}>{listing.title}</a>
               </h3>
            </div>
            
            
            <div className="price-section">
               <span className="current-price">{toINR(listing.price.curr)}</span>
               {listing.inStk && (listing.price.curr !== listing.price.last) && (
                  <span className="original-price">{toINR(listing.price.last)}</span>
               )}
               {listing.inStk && (change < 0) && (
                  <span className="price-drop">↓ {toINR(Math.abs(change))}</span>
               )}
               {listing.inStk && (change > 0) && (
                  <span className="price-increase">↑ {toINR(Math.abs(change))}</span>
               )}
               {!listing.inStk && (
                  <span className="out-of-stock">Out of stock</span>
               )}
            </div>

         </div>
         <button className="remove-btn" onClick={() => showConfirm(true)} title="Remove">×</button>
      </div>
   )
}

function App() {
   const { isLoading, alertText, sortBy, isRefreshing } = Store
   const [isSearchShowing, showSearchBar] = useState(false)
   const [isSortOpen, setSortOpen] = useState(false)
   const sortContainerRef = useRef(null)
   const sortTriggerRef = useRef(null)

   useEffect(onAppMount, [])
   useEffect(() => {
      const handleClickOutside = (event) => {
         if (!sortContainerRef.current) return
         if (!sortContainerRef.current.contains(event.target)) {
            setSortOpen(false)
         }
      }
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
   }, [])

   useEffect(() => {
      if (!sortTriggerRef.current) return
      const label = sortBy.value === "price-low"
         ? "Price: Low to High"
         : sortBy.value === "price-high"
            ? "Price: High to Low"
            : sortBy.value === "discount"
               ? "Discount"
               : sortBy.value === "name"
                  ? "Name"
                  : "Recent"

      const tempSpan = document.createElement('span')
      tempSpan.style.visibility = 'hidden'
      tempSpan.style.position = 'absolute'
      tempSpan.style.whiteSpace = 'nowrap'
      tempSpan.style.font = window.getComputedStyle(sortTriggerRef.current).font
      tempSpan.textContent = label
      document.body.appendChild(tempSpan)
      const textWidth = tempSpan.offsetWidth
      sortTriggerRef.current.style.width = (textWidth + 20) + "px"
      document.body.removeChild(tempSpan)
   }, [sortBy.value])

   return (
      <div className="app-container">
         {alertText.value && <Alert msg={alertText.value} onClose={closeAlert} />}
         {isLoading.value && <Spinner />}

         {/* Header */}
         <div className="header">
            <div className="header-top">
         <div className="logo-section">
                  <div className="logo">
                     <i className="fa-solid fa-cart-shopping" aria-hidden="true"></i>
                  </div>
                  <div className="brand">
                     <h1>ALERTY</h1>
                  </div>
               </div>
               <div className="header-actions">
                  <button 
                     className={`icon-btn ${isSearchShowing ? 'active' : ''}`}
                     onClick={handleSearchToggle(showSearchBar, isSearchShowing)}
                     title="Search">
                     <i className="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
                  </button>
                  <button className="icon-btn" onClick={handleAdd} title="Add product">
                     <i className="fa-solid fa-plus" aria-hidden="true"></i>
                  </button>
               </div>
            </div>
            
            <SearchBar isActive={isSearchShowing} />
         </div>

         {/* Products */}
         <PullToRefresh>
            {/* List Header */}
            <div className="list-header">
               <div className="product-count">
                  {Object.keys(Store.Listings.value).length} items
               </div>
               <div className="sort-container" ref={sortContainerRef}>
                  <label className="sort-label">Sort by:</label>
                  <button
                     className={`sort-select ${isSortOpen ? 'open' : ''}`}
                     onClick={() => setSortOpen(!isSortOpen)}
                     ref={sortTriggerRef}
                     type="button"
                  >
                     {sortBy.value === "price-low"
                        ? "Price: Low to High"
                        : sortBy.value === "price-high"
                           ? "Price: High to Low"
                           : sortBy.value === "discount"
                              ? "Discount"
                              : sortBy.value === "name"
                                 ? "Name"
                                 : "Recent"}
                     <i className="fa-solid fa-chevron-down" aria-hidden="true"></i>
                  </button>
                  {isSortOpen && (
                     <ul className="sort-menu">
                        <li className={`sort-option ${sortBy.value === "recent" ? "active" : ""}`}>
                           <button type="button" onClick={() => { handleSortChange("recent"); setSortOpen(false) }}>Recent</button>
                        </li>
                        <li className={`sort-option ${sortBy.value === "discount" ? "active" : ""}`}>
                           <button type="button" onClick={() => { handleSortChange("discount"); setSortOpen(false) }}>Discount</button>
                        </li>
                        <li className={`sort-option ${sortBy.value === "price-low" ? "active" : ""}`}>
                           <button type="button" onClick={() => { handleSortChange("price-low"); setSortOpen(false) }}>Price: Low to High</button>
                        </li>
                        <li className={`sort-option ${sortBy.value === "price-high" ? "active" : ""}`}>
                           <button type="button" onClick={() => { handleSortChange("price-high"); setSortOpen(false) }}>Price: High to Low</button>
                        </li>
                        <li className={`sort-option ${sortBy.value === "name" ? "active" : ""}`}>
                           <button type="button" onClick={() => { handleSortChange("name"); setSortOpen(false) }}>Name</button>
                        </li>
                     </ul>
                  )}
               </div>
            </div>

            <div className="products">
               {isEmpty(Store.Listings.value) && !isLoading.value ? (
                  <div className="empty-state">
                     <div className="empty-icon">
                        <i className="fa-solid fa-box-open" aria-hidden="true"></i>
                     </div>
                     <p>No products tracked yet</p>
                     <p className="empty-subtitle">Go to Amazon or Flipkart and click the + button to add a product</p>
                  </div>
               ) : (
                  Store.FilteredSorted.value.map((listing) => (
                     <Listing key={listing.key} listing={listing} />
                  ))
               )}
            </div>
         </PullToRefresh>
      </div>
   )
}

Preact.render(<App />, document.getElementById('app'))
