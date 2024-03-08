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
         isSorted = signal(false),
         isRefreshing = signal(false),
         toBeRemoved = signal([]);
   const FilteredSorted = computed(() => {
      const filtered = 
         Object.values(Listings.value)
         .sort((a, b) => b.time - a.time)
         .filter((listing) => listing.title.toLowerCase().includes(searchText.value.toLowerCase()))
      return isSorted.value ? filtered.sort((a, b) => discount(b) - discount(a)) : filtered
   })
   return { Listings, isLoading, alertText, searchText, FilteredSorted, isSorted, isRefreshing, toBeRemoved }
}

const Store = createStore()

const initializeApp = async () => {
   setLoading(true)
   const { IsRefreshing } = await chrome.storage.sync.get(["IsRefreshing"])
   const { IsSorted } = await chrome.storage.sync.get(["IsSorted"])
   const { Listings } = await chrome.storage.sync.get(["Listings"])
   batch(() => {
      setRefreshing(IsRefreshing)
      sortListings(IsSorted)
      updateListings(Listings)
      setLoading(false)
   })
}

// Actions
const updateListings = (list) => { Store.Listings.value = list }
const setLoading     = (bool) => { Store.isLoading.value = bool }
const setAlertText   = (text) => { Store.alertText.value = text }
const setSearchText  = (text) => { Store.searchText.value = text}
const sortListings   = (bool) => { Store.isSorted.value = bool }
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

const handleRefresh = (event) => {
   event.preventDefault()
   !Store.isLoading.value && sendMsg({ action: "RefreshListings" })
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

const handleSort = async (event) => {
   event.preventDefault()
   const toggled = !Store.isSorted.value
   await chrome.storage.sync.set({ IsSorted: toggled })
   sortListings(toggled)
}

const handleCopyLink = (url) => async (event) => {
   event.preventDefault()
   await navigator.clipboard.writeText(url)
   setAlertText("Product link copied to the clipboard")
}

const handleSearchBarClose = (showSearchBar) => () => {
   setSearchText("")
   showSearchBar(false)
}

const onAppMount = () => {
   chrome.runtime.onMessage.addListener(handleMsg)
   initializeApp()
   // on App Un-mount
   return () => chrome.runtime.onMessage.removeListener(handleMsg)
}

const onSearchBarMount = (inputRef) => () => {
   inputRef.current?.focus()
}

// Dumb components
const Spinner = () => (
   <div className="z-index-2 position-absolute top-0 bottom-0 start-0 end-0
                   d-flex justify-content-center align-items-center
                   bg-white bg-opacity-75">
      <i className="fa-solid fa-spinner fa-spin fs-1"></i>
   </div>
)

const Alert = ({ msg, onClose }) => (
   <div className="z-index-2 position-absolute top-0 bottom-0 start-0 end-0
                   d-flex justify-content-center align-items-center
                   bg-white bg-opacity-75">
      <div className="position-relative
                      shadow-lg border rounded
                      ps-2 pe-4 py-1 bg-white">
         <span className="small">{msg}</span>
         <div className="position-absolute end-0 top-0 pe-1 small">
            <i className="fa-solid fa-xmark clickable" onClick={onClose}></i>
         </div>
      </div>
   </div>
)

const DelConfirmation = ({ onOk, onClose }) => (
   <div className="z-index-1 position-absolute top-0 bottom-0 start-0 end-0
                   d-flex justify-content-center align-items-center
                   bg-white bg-opacity-75 rounded">
      <div className="position-relative
                      shadow-lg border rounded
                      px-3 py-1 bg-white">
         <div className="small text-center">Click <i className="fa-solid fa-check"></i> to remove the listing</div>
         <div className="text-center mt-1">
            <i className="fa-solid fa-check clickable me-3" onClick={onOk}></i>
            <i className="fa-solid fa-xmark clickable" onClick={onClose}></i>
         </div>
      </div>
   </div>
)

function SearchBar({ onClose }) {
   const { searchText } = Store
   const inputRef = useRef(null)
   useEffect(onSearchBarMount(inputRef), [])
   return (
      <div className="input-group input-group-sm py-1">
         <span className="input-group-text">
            <i className="fa-solid fa-magnifying-glass"></i>
         </span>
         <input className="form-control ls-05" ref={inputRef} autoFocus={true} type="search" placeholder="search listings..." value={searchText.value} onInput={handleInput} />
         <span className="input-group-text">
            <i className="fa-solid fa-xmark clickable" onClick={onClose}></i>
         </span>
      </div>
   )
}

function Listing({ listing }) {
   const change = listing.price.curr - listing.price.last
   const [isConfirming, showConfirm] = useState(false)
   return (
      <div className="listing mb-2
                      d-flex bg-light bg-opacity-50
                      position-relative border
                      rounded p-1">
         
         {isConfirming && <DelConfirmation onOk={handleDel(listing)} onClose={() => showConfirm(false)}/>}
         
         <div className="img-div me-1 position-relative">
            <img className="rounded" src={listing.image} alt="Product Image" />
            <div className="position-absolute end-0 top-0 
                            me-1 mt-1 px-1
                            bg-white bg-opacity-75 rounded">
               <i className="fa-solid fa-copy clickable" onClick={handleCopyLink(listing.url)} title="Copy product link"></i>
            </div>
         </div>
         
         <div className="d-flex flex-column ps-2 pe-3 gap-2">
            <a className="line-clamp clickable text-decoration-none color-unset text-gray-700" target="blank" href={listing.url} title={listing.title}>{listing.title}</a>
            {listing.inStk &&
            <div className="price gap-3 small">
               <span title="Current price">{toINR(listing.price.curr)}</span>
               {listing.price.curr !== listing.price.last && <Fragment><s className="text-gray-600 ms-3" title="Previous price">{toINR(listing.price.last)}</s></Fragment>}
               {listing.price.curr < listing.price.last   && <Fragment><span className="ms-3 text-success" title="Discount">{toINR(Math.abs(change))} off</span></Fragment>}
            </div>}
            {!listing.inStk && <Fragment><span className="small text-gray-600" title="Out of stock">Currently unavailable</span></Fragment>}
         </div>
         
         <div className="position-absolute end-0 top-0 pe-1">
            <i className="fa-solid fa-xmark remove-btn clickable" onClick={() => showConfirm(true)} title="Remove the listing"></i>
         </div>

      </div>
   )
}

function App() {
   const { isLoading, alertText, isSorted, isRefreshing } = Store
   const [isSearchBarShowing, showSearchBar] = useState(false)

   useEffect(onAppMount, [])

   return (
      <div className="app border position-relative text-gray-700 d-flex flex-column ls-05">
         
         {alertText.value && <Alert msg={alertText.value} onClose={closeAlert} />}
         {isLoading.value && <Spinner />}

         {/* header */}
         <div className="d-flex justify-content-between
                         bg-light
                         shadow-sm px-2
                         border-bottom">
            <div className="py-2 px-1">
               <a className="small clickable text-decoration-none color-unset" 
                  target="blank" 
                  href={POPUP_PATH} 
                  title="Open extension as a new TAB">
                     <i class="fa-solid fa-cart-arrow-down"></i>
                     <span class="ms-1 ls-1">Alerty</span></a>
            </div>
            <div className="d-flex justify-content-between">
               {isSearchBarShowing
                  ?  <SearchBar onClose={handleSearchBarClose(showSearchBar)} />
                  :  <div className="py-2 fs-095">
                        <i className="fa-solid fa-magnifying-glass clickable" onClick={() => showSearchBar(true)} title="Search/Filter the listings..."></i>
                     </div>}
               <div className="ms-2 py-2">
                  <i className="fa-solid fa-plus clickable fs-120" onClick={handleAdd} title="Add the product listing"></i>
               </div>
            </div>
         </div>

         {/* body */}
         <div className="d-flex flex-column
                         flex-grow-1
                         py-2 px-2
                         scroll-y">
            {isEmpty(Store.Listings.value) && (!isLoading.value)
               ? <div className="p-1 mt-2 small">Goto the Amazon/Flipkart product page and Hit <i className="fa-solid fa-plus"></i> button to add the product listing.</div>
               : Store.FilteredSorted.value.map((listing) => <Listing key={listing.key} listing={listing} />) }
         </div>

         {/* footer */}
         <div className="d-flex justify-content-end
                         bg-light
                         py-1 pe-2
                         border-top">
            <div>
               <i className={isSorted.value ? "fa-solid fa-clock clickable me-2" : "fa-solid fa-arrow-up-wide-short clickable me-2"}
                  onClick={handleSort} 
                  title={isSorted.value ? "Sort by chronology" : "Sort by discount"}></i>
               {isRefreshing.value
                  ? <i className="fa-solid fa-arrows-rotate fa-spin" title="Re-fetching the new prices..."></i>
                  : <i className="fa-solid fa-arrows-rotate clickable" onClick={handleRefresh} title="Click here to re-fetch prices"></i>}
            </div>
         </div>

      </div>
   )
}

Preact.render(<App />, document.getElementById('app'))
